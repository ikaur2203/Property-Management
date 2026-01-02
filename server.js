// server.js - Node.js Express server with Azure SQL Database
require('dotenv').config();
const express = require('express');
const sql = require('mssql');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const { BlobServiceClient } = require('@azure/storage-blob');
const session = require('express-session');
const bcrypt = require('bcryptjs');

const app = express();
const PORT = process.env.PORT || 8080;

// Azure Blob Storage Configuration
const AZURE_STORAGE_CONNECTION_STRING = process.env.AZURE_STORAGE_CONNECTION_STRING;
const AZURE_STORAGE_CONTAINER_NAME = process.env.AZURE_STORAGE_CONTAINER_NAME || 'lease-documents';
const USE_AZURE_STORAGE = !!AZURE_STORAGE_CONNECTION_STRING;

let blobServiceClient, containerClient;
if (USE_AZURE_STORAGE) {
    try {
        blobServiceClient = BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONNECTION_STRING);
        containerClient = blobServiceClient.getContainerClient(AZURE_STORAGE_CONTAINER_NAME);

        containerClient.createIfNotExists({ access: 'blob' })
            .then(() => console.log('✅ Azure Blob Storage connected'))
            .catch(err => console.error('⚠️ Azure Blob Storage error:', err.message));
    } catch (error) {
        console.error('⚠️ Failed to initialize Azure Storage:', error.message);
    }
}

// Azure SQL Database Configuration
const dbConfig = {
    server: process.env.AZURE_SQL_SERVER,
    database: process.env.AZURE_SQL_DATABASE,
    user: process.env.AZURE_SQL_USER,
    password: process.env.AZURE_SQL_PASSWORD,
    options: {
        encrypt: true,
        trustServerCertificate: false,
        enableArithAbort: true
    },
    pool: {
        max: 10,
        min: 0,
        idleTimeoutMillis: 30000
    }
};

// Global connection pool
let poolPromise;

// Initialize database connection
async function initializeDatabase() {
    try {
        poolPromise = sql.connect(dbConfig);
        await poolPromise;
        console.log('✅ Connected to Azure SQL Database');

        // Create tables if they don't exist
        await createTables();
    } catch (err) {
        console.error('❌ Database connection failed:', err.message);
        process.exit(1);
    }
}

// Create database tables
async function createTables() {
    const pool = await poolPromise;

    // Owners table (must be created first)
    await pool.request().query(`
        IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='owners' AND xtype='U')
        CREATE TABLE owners (
            id INT IDENTITY(1,1) PRIMARY KEY,
            email NVARCHAR(255) NOT NULL UNIQUE,
            password_hash NVARCHAR(255) NOT NULL,
            name NVARCHAR(255) NOT NULL,
            is_admin BIT DEFAULT 0,
            created_at DATETIME2 DEFAULT GETDATE(),
            last_login DATETIME2
        )
    `);

    // Companies/LLCs table (must be created before properties)
    await pool.request().query(`
        IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='companies' AND xtype='U')
        CREATE TABLE companies (
            id INT IDENTITY(1,1) PRIMARY KEY,
            name NVARCHAR(255) NOT NULL,
            notes NVARCHAR(MAX),
            created_at DATETIME2 DEFAULT GETDATE()
        )
    `);

    // Add owner_id column to companies table if it doesn't exist
    await pool.request().query(`
        IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('companies') AND name = 'owner_id')
        ALTER TABLE companies ADD owner_id INT NULL
    `);

    // Properties table (with separate address fields)
    await pool.request().query(`
        IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='properties' AND xtype='U')
        CREATE TABLE properties (
            id INT IDENTITY(1,1) PRIMARY KEY,
            address1 NVARCHAR(255) NOT NULL,
            city NVARCHAR(100) NOT NULL,
            state NVARCHAR(50) NOT NULL,
            zip NVARCHAR(20) NOT NULL,
            type NVARCHAR(100) NOT NULL,
            company_id INT,
            status NVARCHAR(50) NOT NULL DEFAULT 'available',
            notes NVARCHAR(MAX),
            created_at DATETIME2 DEFAULT GETDATE(),
            FOREIGN KEY (company_id) REFERENCES companies(id)
        )
    `);

    // Add company_id column to existing properties table if it doesn't exist
    await pool.request().query(`
        IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('properties') AND name = 'company_id')
        ALTER TABLE properties ADD company_id INT NULL
    `);

    // Add notes column to existing properties table if it doesn't exist
    await pool.request().query(`
        IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('properties') AND name = 'notes')
        ALTER TABLE properties ADD notes NVARCHAR(MAX) NULL
    `);

    // Add owner_id column to properties table if it doesn't exist
    await pool.request().query(`
        IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('properties') AND name = 'owner_id')
        ALTER TABLE properties ADD owner_id INT NULL
    `);

    // Drop old columns from properties table if they exist (purchase_price, current_value, monthly_mortgage)
    await pool.request().query(`
        IF EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('properties') AND name = 'purchase_price')
        ALTER TABLE properties DROP COLUMN purchase_price
    `);
    await pool.request().query(`
        IF EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('properties') AND name = 'current_value')
        ALTER TABLE properties DROP COLUMN current_value
    `);
    await pool.request().query(`
        IF EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('properties') AND name = 'monthly_mortgage')
        ALTER TABLE properties DROP COLUMN monthly_mortgage
    `);

    // Add new address fields to existing properties table
    await pool.request().query(`
        IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('properties') AND name = 'address1')
        ALTER TABLE properties ADD address1 NVARCHAR(255) NULL
    `);
    await pool.request().query(`
        IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('properties') AND name = 'city')
        ALTER TABLE properties ADD city NVARCHAR(100) NULL
    `);
    await pool.request().query(`
        IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('properties') AND name = 'state')
        ALTER TABLE properties ADD state NVARCHAR(50) NULL
    `);
    await pool.request().query(`
        IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('properties') AND name = 'zip')
        ALTER TABLE properties ADD zip NVARCHAR(20) NULL
    `);

    // Migrate data from old 'address' column to new fields if address column exists
    await pool.request().query(`
        IF EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('properties') AND name = 'address')
        BEGIN
            UPDATE properties SET address1 = address WHERE address1 IS NULL AND address IS NOT NULL
            UPDATE properties SET city = '' WHERE city IS NULL
            UPDATE properties SET state = '' WHERE state IS NULL
            UPDATE properties SET zip = '' WHERE zip IS NULL
        END
    `);

    // Drop old address column if it exists (after migration)
    await pool.request().query(`
        IF EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('properties') AND name = 'address')
        ALTER TABLE properties DROP COLUMN address
    `);

    // Tenants table
    await pool.request().query(`
        IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='tenants' AND xtype='U')
        CREATE TABLE tenants (
            id INT IDENTITY(1,1) PRIMARY KEY,
            name NVARCHAR(255) NOT NULL,
            phone NVARCHAR(50) NOT NULL,
            email NVARCHAR(255),
            floor NVARCHAR(100),
            property_id INT,
            emergency_contact NVARCHAR(255),
            emergency_phone NVARCHAR(50),
            notes NVARCHAR(MAX),
            created_at DATETIME2 DEFAULT GETDATE(),
            FOREIGN KEY (property_id) REFERENCES properties(id)
        )
    `);

    // Leases table
    await pool.request().query(`
        IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='leases' AND xtype='U')
        CREATE TABLE leases (
            id INT IDENTITY(1,1) PRIMARY KEY,
            property_id INT NOT NULL,
            tenant_id INT NOT NULL,
            start_date DATE NOT NULL,
            end_date DATE NOT NULL,
            rent DECIMAL(18,2) NOT NULL,
            deposit DECIMAL(18,2),
            document_filename NVARCHAR(500),
            document_original_name NVARCHAR(500),
            document_uploaded_at DATETIME2,
            notes NVARCHAR(MAX),
            created_at DATETIME2 DEFAULT GETDATE(),
            FOREIGN KEY (property_id) REFERENCES properties(id),
            FOREIGN KEY (tenant_id) REFERENCES tenants(id)
        )
    `);

    // Expenses table (with company_id for company-level expenses like mortgages)
    await pool.request().query(`
        IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='expenses' AND xtype='U')
        CREATE TABLE expenses (
            id INT IDENTITY(1,1) PRIMARY KEY,
            date DATE NOT NULL,
            property_id INT,
            company_id INT,
            category NVARCHAR(100) NOT NULL,
            amount DECIMAL(18,2) NOT NULL,
            description NVARCHAR(500) NOT NULL,
            created_at DATETIME2 DEFAULT GETDATE(),
            FOREIGN KEY (property_id) REFERENCES properties(id),
            FOREIGN KEY (company_id) REFERENCES companies(id)
        )
    `);

    // Add company_id column to existing expenses table if it doesn't exist
    await pool.request().query(`
        IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('expenses') AND name = 'company_id')
        ALTER TABLE expenses ADD company_id INT NULL
    `);

    // Rent Payments table
    await pool.request().query(`
        IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='rent_payments' AND xtype='U')
        CREATE TABLE rent_payments (
            id INT IDENTITY(1,1) PRIMARY KEY,
            tenant_id INT NOT NULL,
            payment_date DATE NOT NULL,
            amount DECIMAL(18,2) NOT NULL,
            payment_method NVARCHAR(50) NOT NULL,
            check_number NVARCHAR(100),
            paid_in_full BIT DEFAULT 0,
            notes NVARCHAR(MAX),
            created_at DATETIME2 DEFAULT GETDATE(),
            FOREIGN KEY (tenant_id) REFERENCES tenants(id)
        )
    `);

    // Custom expense categories table
    await pool.request().query(`
        IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='expense_categories' AND xtype='U')
        CREATE TABLE expense_categories (
            id INT IDENTITY(1,1) PRIMARY KEY,
            name NVARCHAR(100) NOT NULL,
            created_at DATETIME2 DEFAULT GETDATE()
        )
    `);

    // Add owner_id column to expense_categories table if it doesn't exist
    await pool.request().query(`
        IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('expense_categories') AND name = 'owner_id')
        ALTER TABLE expense_categories ADD owner_id INT NULL
    `);

    console.log('✅ Database tables initialized');
}

// Local uploads directory (fallback if Azure not configured)
const uploadsDir = path.join(__dirname, 'uploads');
if (!USE_AZURE_STORAGE && !fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configure multer for file uploads
const storage = USE_AZURE_STORAGE
    ? multer.memoryStorage()
    : multer.diskStorage({
        destination: function (req, file, cb) {
            cb(null, uploadsDir);
        },
        filename: function (req, file, cb) {
            const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
            cb(null, 'lease-' + uniqueSuffix + path.extname(file.originalname));
        }
    });

const upload = multer({
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: function (req, file, cb) {
        const allowedTypes = /pdf|doc|docx|jpg|jpeg|png/;
        const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = allowedTypes.test(file.mimetype);

        if (mimetype && extname) {
            return cb(null, true);
        } else {
            cb(new Error('Only PDF, DOC, DOCX, JPG, JPEG, PNG files are allowed!'));
        }
    }
});

// Middleware
app.use(express.json());
app.use(cors({
    credentials: true,
    origin: true
}));

// Trust proxy for Azure App Service (required for secure cookies behind load balancer)
app.set('trust proxy', 1);

// Session configuration
app.use(session({
    secret: process.env.SESSION_SECRET || 'property-management-secret-key-change-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000, // 24 hours
        sameSite: 'lax'
    }
}));

app.use(express.static('public'));

if (!USE_AZURE_STORAGE) {
    app.use('/uploads', express.static(uploadsDir));
}

// Authentication middleware
function requireAuth(req, res, next) {
    if (req.session && req.session.ownerId) {
        req.ownerId = req.session.ownerId;
        next();
    } else {
        res.status(401).json({ error: 'Authentication required' });
    }
}

// Admin-only middleware
function requireAdmin(req, res, next) {
    if (req.session && req.session.isAdmin) {
        next();
    } else {
        res.status(403).json({ error: 'Admin access required' });
    }
}

// PWA Routes
app.get('/manifest.json', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'manifest.json'));
});

app.get('/sw.js', (req, res) => {
    res.setHeader('Content-Type', 'application/javascript');
    res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});

// ==================== AUTHENTICATION ROUTES ====================
// Login endpoint
app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const pool = await poolPromise;
        const result = await pool.request()
            .input('email', sql.NVarChar, email)
            .query('SELECT * FROM owners WHERE email = @email');

        const owner = result.recordset[0];

        if (!owner) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        const validPassword = await bcrypt.compare(password, owner.password_hash);

        if (!validPassword) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        // Update last login
        await pool.request()
            .input('id', sql.Int, owner.id)
            .query('UPDATE owners SET last_login = GETDATE() WHERE id = @id');

        // Set session
        req.session.ownerId = owner.id;
        req.session.ownerEmail = owner.email;
        req.session.ownerName = owner.name;
        req.session.isAdmin = owner.is_admin;

        res.json({
            success: true,
            owner: {
                id: owner.id,
                email: owner.email,
                name: owner.name,
                isAdmin: owner.is_admin
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Logout endpoint
app.post('/api/auth/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) {
            return res.status(500).json({ error: 'Failed to logout' });
        }
        res.json({ success: true });
    });
});

// Check session endpoint
app.get('/api/auth/session', (req, res) => {
    if (req.session && req.session.ownerId) {
        res.json({
            authenticated: true,
            owner: {
                id: req.session.ownerId,
                email: req.session.ownerEmail,
                name: req.session.ownerName,
                isAdmin: req.session.isAdmin
            }
        });
    } else {
        res.json({ authenticated: false });
    }
});

// Admin: Create owner
app.post('/api/admin/owners', requireAuth, requireAdmin, async (req, res) => {
    const { email, password, name, isAdmin } = req.body;
    try {
        const pool = await poolPromise;

        // Check if email already exists
        const existing = await pool.request()
            .input('email', sql.NVarChar, email)
            .query('SELECT id FROM owners WHERE email = @email');

        if (existing.recordset.length > 0) {
            return res.status(400).json({ error: 'Email already exists' });
        }

        // Hash password
        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(password, salt);

        const result = await pool.request()
            .input('email', sql.NVarChar, email)
            .input('password_hash', sql.NVarChar, passwordHash)
            .input('name', sql.NVarChar, name)
            .input('is_admin', sql.Bit, isAdmin ? 1 : 0)
            .query(`INSERT INTO owners (email, password_hash, name, is_admin)
                    OUTPUT INSERTED.id
                    VALUES (@email, @password_hash, @name, @is_admin)`);

        res.json({ id: result.recordset[0].id, message: 'Owner created successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Admin: List all owners
app.get('/api/admin/owners', requireAuth, requireAdmin, async (req, res) => {
    try {
        const pool = await poolPromise;
        const result = await pool.request()
            .query('SELECT id, email, name, is_admin, created_at, last_login FROM owners ORDER BY name ASC');
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==================== COMPANIES ROUTES ====================
app.get('/api/companies', requireAuth, async (req, res) => {
    try {
        const pool = await poolPromise;
        const result = await pool.request()
            .input('ownerId', sql.Int, req.ownerId)
            .query('SELECT * FROM companies WHERE owner_id = @ownerId ORDER BY name ASC');
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/companies', requireAuth, async (req, res) => {
    const { name, notes } = req.body;
    try {
        const pool = await poolPromise;
        const result = await pool.request()
            .input('name', sql.NVarChar, name)
            .input('notes', sql.NVarChar, notes || '')
            .input('owner_id', sql.Int, req.ownerId)
            .query(`INSERT INTO companies (name, notes, owner_id)
                    OUTPUT INSERTED.id
                    VALUES (@name, @notes, @owner_id)`);

        res.json({ id: result.recordset[0].id, message: 'Company created successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/companies/:id', requireAuth, async (req, res) => {
    const { name, notes } = req.body;
    const { id } = req.params;
    try {
        const pool = await poolPromise;

        // Verify ownership
        const ownerCheck = await pool.request()
            .input('id', sql.Int, id)
            .input('ownerId', sql.Int, req.ownerId)
            .query('SELECT id FROM companies WHERE id = @id AND owner_id = @ownerId');

        if (ownerCheck.recordset.length === 0) {
            return res.status(403).json({ error: 'Not authorized to modify this company' });
        }

        await pool.request()
            .input('id', sql.Int, id)
            .input('name', sql.NVarChar, name)
            .input('notes', sql.NVarChar, notes || '')
            .query(`UPDATE companies SET name = @name, notes = @notes WHERE id = @id`);

        res.json({ message: 'Company updated successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/companies/:id', requireAuth, async (req, res) => {
    const { id } = req.params;
    try {
        const pool = await poolPromise;

        // Verify ownership
        const ownerCheck = await pool.request()
            .input('id', sql.Int, id)
            .input('ownerId', sql.Int, req.ownerId)
            .query('SELECT id FROM companies WHERE id = @id AND owner_id = @ownerId');

        if (ownerCheck.recordset.length === 0) {
            return res.status(403).json({ error: 'Not authorized to delete this company' });
        }

        await pool.request()
            .input('id', sql.Int, id)
            .query('DELETE FROM companies WHERE id = @id');

        res.json({ message: 'Company deleted successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==================== PROPERTIES ROUTES ====================
app.get('/api/properties', requireAuth, async (req, res) => {
    try {
        const pool = await poolPromise;
        const result = await pool.request()
            .input('ownerId', sql.Int, req.ownerId)
            .query(`
                SELECT p.*, c.name as company_name
                FROM properties p
                LEFT JOIN companies c ON p.company_id = c.id
                WHERE p.owner_id = @ownerId OR c.owner_id = @ownerId
                ORDER BY p.created_at DESC
            `);
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/properties', requireAuth, async (req, res) => {
    const { address1, city, state, zip, type, company_id, status, notes } = req.body;
    try {
        const pool = await poolPromise;
        const result = await pool.request()
            .input('address1', sql.NVarChar, address1)
            .input('city', sql.NVarChar, city)
            .input('state', sql.NVarChar, state)
            .input('zip', sql.NVarChar, zip)
            .input('type', sql.NVarChar, type)
            .input('company_id', sql.Int, company_id || null)
            .input('status', sql.NVarChar, status)
            .input('notes', sql.NVarChar, notes || '')
            .input('owner_id', sql.Int, req.ownerId)
            .query(`INSERT INTO properties (address1, city, state, zip, type, company_id, status, notes, owner_id)
                    OUTPUT INSERTED.id
                    VALUES (@address1, @city, @state, @zip, @type, @company_id, @status, @notes, @owner_id)`);

        res.json({ id: result.recordset[0].id, message: 'Property created successfully' });
    } catch (err) {
        console.error('Error creating property:', err);
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/properties/:id', requireAuth, async (req, res) => {
    const { address1, city, state, zip, type, company_id, status, notes } = req.body;
    const { id } = req.params;
    try {
        const pool = await poolPromise;

        // Verify ownership
        const ownerCheck = await pool.request()
            .input('id', sql.Int, id)
            .input('ownerId', sql.Int, req.ownerId)
            .query(`SELECT p.id FROM properties p
                    LEFT JOIN companies c ON p.company_id = c.id
                    WHERE p.id = @id AND (p.owner_id = @ownerId OR c.owner_id = @ownerId)`);

        if (ownerCheck.recordset.length === 0) {
            return res.status(403).json({ error: 'Not authorized to modify this property' });
        }

        await pool.request()
            .input('id', sql.Int, id)
            .input('address1', sql.NVarChar, address1)
            .input('city', sql.NVarChar, city)
            .input('state', sql.NVarChar, state)
            .input('zip', sql.NVarChar, zip)
            .input('type', sql.NVarChar, type)
            .input('company_id', sql.Int, company_id || null)
            .input('status', sql.NVarChar, status)
            .input('notes', sql.NVarChar, notes || '')
            .query(`UPDATE properties SET address1 = @address1, city = @city, state = @state, zip = @zip,
                    type = @type, company_id = @company_id, status = @status, notes = @notes WHERE id = @id`);

        res.json({ message: 'Property updated successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/properties/:id', requireAuth, async (req, res) => {
    const { id } = req.params;
    try {
        const pool = await poolPromise;

        // Verify ownership
        const ownerCheck = await pool.request()
            .input('id', sql.Int, id)
            .input('ownerId', sql.Int, req.ownerId)
            .query(`SELECT p.id FROM properties p
                    LEFT JOIN companies c ON p.company_id = c.id
                    WHERE p.id = @id AND (p.owner_id = @ownerId OR c.owner_id = @ownerId)`);

        if (ownerCheck.recordset.length === 0) {
            return res.status(403).json({ error: 'Not authorized to delete this property' });
        }

        await pool.request()
            .input('id', sql.Int, id)
            .query('DELETE FROM properties WHERE id = @id');

        res.json({ message: 'Property deleted successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==================== TENANTS ROUTES ====================
app.get('/api/tenants', requireAuth, async (req, res) => {
    try {
        const pool = await poolPromise;
        const result = await pool.request()
            .input('ownerId', sql.Int, req.ownerId)
            .query(`
                SELECT t.*, p.address1 as property_address
                FROM tenants t
                LEFT JOIN properties p ON t.property_id = p.id
                LEFT JOIN companies c ON p.company_id = c.id
                WHERE p.owner_id = @ownerId OR c.owner_id = @ownerId
                ORDER BY t.created_at DESC
            `);
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/tenants', requireAuth, async (req, res) => {
    const { name, phone, email, floor, property_id, emergency_contact, emergency_phone, notes } = req.body;
    try {
        const pool = await poolPromise;

        // Verify property ownership if property_id is provided
        if (property_id) {
            const ownerCheck = await pool.request()
                .input('propertyId', sql.Int, property_id)
                .input('ownerId', sql.Int, req.ownerId)
                .query(`SELECT p.id FROM properties p
                        LEFT JOIN companies c ON p.company_id = c.id
                        WHERE p.id = @propertyId AND (p.owner_id = @ownerId OR c.owner_id = @ownerId)`);

            if (ownerCheck.recordset.length === 0) {
                return res.status(403).json({ error: 'Not authorized to add tenant to this property' });
            }
        }

        const result = await pool.request()
            .input('name', sql.NVarChar, name)
            .input('phone', sql.NVarChar, phone)
            .input('email', sql.NVarChar, email || '')
            .input('floor', sql.NVarChar, floor || '')
            .input('property_id', sql.Int, property_id || null)
            .input('emergency_contact', sql.NVarChar, emergency_contact || '')
            .input('emergency_phone', sql.NVarChar, emergency_phone || '')
            .input('notes', sql.NVarChar, notes || '')
            .query(`INSERT INTO tenants (name, phone, email, floor, property_id, emergency_contact, emergency_phone, notes)
                    OUTPUT INSERTED.id
                    VALUES (@name, @phone, @email, @floor, @property_id, @emergency_contact, @emergency_phone, @notes)`);

        res.json({ id: result.recordset[0].id, message: 'Tenant created successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/tenants/:id', requireAuth, async (req, res) => {
    const { name, phone, email, floor, property_id, emergency_contact, emergency_phone, notes } = req.body;
    const { id } = req.params;
    try {
        const pool = await poolPromise;

        // Verify tenant ownership through property
        const ownerCheck = await pool.request()
            .input('id', sql.Int, id)
            .input('ownerId', sql.Int, req.ownerId)
            .query(`SELECT t.id FROM tenants t
                    LEFT JOIN properties p ON t.property_id = p.id
                    LEFT JOIN companies c ON p.company_id = c.id
                    WHERE t.id = @id AND (p.owner_id = @ownerId OR c.owner_id = @ownerId)`);

        if (ownerCheck.recordset.length === 0) {
            return res.status(403).json({ error: 'Not authorized to modify this tenant' });
        }

        await pool.request()
            .input('id', sql.Int, id)
            .input('name', sql.NVarChar, name)
            .input('phone', sql.NVarChar, phone)
            .input('email', sql.NVarChar, email || '')
            .input('floor', sql.NVarChar, floor || '')
            .input('property_id', sql.Int, property_id || null)
            .input('emergency_contact', sql.NVarChar, emergency_contact || '')
            .input('emergency_phone', sql.NVarChar, emergency_phone || '')
            .input('notes', sql.NVarChar, notes || '')
            .query(`UPDATE tenants SET name = @name, phone = @phone, email = @email, floor = @floor,
                    property_id = @property_id, emergency_contact = @emergency_contact,
                    emergency_phone = @emergency_phone, notes = @notes WHERE id = @id`);

        res.json({ message: 'Tenant updated successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/tenants/:id', requireAuth, async (req, res) => {
    const { id } = req.params;
    try {
        const pool = await poolPromise;

        // Verify tenant ownership through property
        const ownerCheck = await pool.request()
            .input('id', sql.Int, id)
            .input('ownerId', sql.Int, req.ownerId)
            .query(`SELECT t.id FROM tenants t
                    LEFT JOIN properties p ON t.property_id = p.id
                    LEFT JOIN companies c ON p.company_id = c.id
                    WHERE t.id = @id AND (p.owner_id = @ownerId OR c.owner_id = @ownerId)`);

        if (ownerCheck.recordset.length === 0) {
            return res.status(403).json({ error: 'Not authorized to delete this tenant' });
        }

        await pool.request()
            .input('id', sql.Int, id)
            .query('DELETE FROM tenants WHERE id = @id');

        res.json({ message: 'Tenant deleted successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==================== LEASES ROUTES ====================
app.get('/api/leases', requireAuth, async (req, res) => {
    try {
        const pool = await poolPromise;
        const result = await pool.request()
            .input('ownerId', sql.Int, req.ownerId)
            .query(`
                SELECT l.*, t.name as tenant_name, p.address1 as property_address
                FROM leases l
                LEFT JOIN tenants t ON l.tenant_id = t.id
                LEFT JOIN properties p ON l.property_id = p.id
                LEFT JOIN companies c ON p.company_id = c.id
                WHERE p.owner_id = @ownerId OR c.owner_id = @ownerId
                ORDER BY l.start_date DESC
            `);
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/leases', requireAuth, async (req, res) => {
    const { property_id, tenant_id, start_date, end_date, rent, deposit, notes } = req.body;
    try {
        const pool = await poolPromise;

        // Verify property ownership
        const ownerCheck = await pool.request()
            .input('propertyId', sql.Int, property_id)
            .input('ownerId', sql.Int, req.ownerId)
            .query(`SELECT p.id FROM properties p
                    LEFT JOIN companies c ON p.company_id = c.id
                    WHERE p.id = @propertyId AND (p.owner_id = @ownerId OR c.owner_id = @ownerId)`);

        if (ownerCheck.recordset.length === 0) {
            return res.status(403).json({ error: 'Not authorized to create lease for this property' });
        }

        const result = await pool.request()
            .input('property_id', sql.Int, property_id)
            .input('tenant_id', sql.Int, tenant_id)
            .input('start_date', sql.Date, start_date)
            .input('end_date', sql.Date, end_date)
            .input('rent', sql.Decimal(18, 2), rent)
            .input('deposit', sql.Decimal(18, 2), deposit || null)
            .input('notes', sql.NVarChar, notes || '')
            .query(`INSERT INTO leases (property_id, tenant_id, start_date, end_date, rent, deposit, notes)
                    OUTPUT INSERTED.id
                    VALUES (@property_id, @tenant_id, @start_date, @end_date, @rent, @deposit, @notes)`);

        res.json({ id: result.recordset[0].id, message: 'Lease created successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/leases/:id', requireAuth, async (req, res) => {
    const { property_id, tenant_id, start_date, end_date, rent, deposit, notes } = req.body;
    const { id } = req.params;
    try {
        const pool = await poolPromise;

        // Verify lease ownership through property
        const ownerCheck = await pool.request()
            .input('id', sql.Int, id)
            .input('ownerId', sql.Int, req.ownerId)
            .query(`SELECT l.id FROM leases l
                    LEFT JOIN properties p ON l.property_id = p.id
                    LEFT JOIN companies c ON p.company_id = c.id
                    WHERE l.id = @id AND (p.owner_id = @ownerId OR c.owner_id = @ownerId)`);

        if (ownerCheck.recordset.length === 0) {
            return res.status(403).json({ error: 'Not authorized to modify this lease' });
        }

        await pool.request()
            .input('id', sql.Int, id)
            .input('property_id', sql.Int, property_id)
            .input('tenant_id', sql.Int, tenant_id)
            .input('start_date', sql.Date, start_date)
            .input('end_date', sql.Date, end_date)
            .input('rent', sql.Decimal(18, 2), rent)
            .input('deposit', sql.Decimal(18, 2), deposit || null)
            .input('notes', sql.NVarChar, notes || '')
            .query(`UPDATE leases SET property_id = @property_id, tenant_id = @tenant_id,
                    start_date = @start_date, end_date = @end_date, rent = @rent,
                    deposit = @deposit, notes = @notes WHERE id = @id`);

        res.json({ message: 'Lease updated successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/leases/:id', requireAuth, async (req, res) => {
    const { id } = req.params;
    try {
        const pool = await poolPromise;

        // Verify lease ownership through property
        const ownerCheck = await pool.request()
            .input('id', sql.Int, id)
            .input('ownerId', sql.Int, req.ownerId)
            .query(`SELECT l.id, l.document_filename FROM leases l
                    LEFT JOIN properties p ON l.property_id = p.id
                    LEFT JOIN companies c ON p.company_id = c.id
                    WHERE l.id = @id AND (p.owner_id = @ownerId OR c.owner_id = @ownerId)`);

        if (ownerCheck.recordset.length === 0) {
            return res.status(403).json({ error: 'Not authorized to delete this lease' });
        }

        const lease = ownerCheck.recordset[0];

        // Delete file if exists
        if (lease && lease.document_filename) {
            if (USE_AZURE_STORAGE) {
                try {
                    const blobClient = containerClient.getBlobClient(lease.document_filename);
                    await blobClient.deleteIfExists();
                } catch (error) {
                    console.error('Error deleting blob:', error);
                }
            } else {
                const filePath = path.join(uploadsDir, lease.document_filename);
                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                }
            }
        }

        // Delete lease record
        await pool.request()
            .input('id', sql.Int, id)
            .query('DELETE FROM leases WHERE id = @id');

        res.json({ message: 'Lease deleted successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Upload lease document
app.post('/api/leases/:id/upload', requireAuth, upload.single('document'), async (req, res) => {
    const { id } = req.params;

    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }

    try {
        const pool = await poolPromise;

        // Verify lease ownership
        const ownerCheck = await pool.request()
            .input('id', sql.Int, id)
            .input('ownerId', sql.Int, req.ownerId)
            .query(`SELECT l.id FROM leases l
                    LEFT JOIN properties p ON l.property_id = p.id
                    LEFT JOIN companies c ON p.company_id = c.id
                    WHERE l.id = @id AND (p.owner_id = @ownerId OR c.owner_id = @ownerId)`);

        if (ownerCheck.recordset.length === 0) {
            return res.status(403).json({ error: 'Not authorized to upload document to this lease' });
        }
        const originalName = req.file.originalname;
        const uploadedAt = new Date().toISOString();
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const filename = 'lease-' + uniqueSuffix + path.extname(originalName);
        let fileUrl;

        if (USE_AZURE_STORAGE) {
            const blockBlobClient = containerClient.getBlockBlobClient(filename);
            await blockBlobClient.upload(req.file.buffer, req.file.buffer.length, {
                blobHTTPHeaders: {
                    blobContentType: req.file.mimetype
                }
            });
            fileUrl = blockBlobClient.url;
        } else {
            fileUrl = `/uploads/${filename}`;
        }

        await pool.request()
            .input('id', sql.Int, id)
            .input('filename', sql.NVarChar, filename)
            .input('originalName', sql.NVarChar, originalName)
            .input('uploadedAt', sql.DateTime2, uploadedAt)
            .query(`UPDATE leases SET document_filename = @filename,
                    document_original_name = @originalName,
                    document_uploaded_at = @uploadedAt WHERE id = @id`);

        res.json({
            message: 'Document uploaded successfully',
            filename: filename,
            originalName: originalName,
            url: fileUrl
        });
    } catch (error) {
        console.error('Upload error:', error);

        // Cleanup on error
        if (USE_AZURE_STORAGE && filename) {
            containerClient.getBlobClient(filename).deleteIfExists().catch(console.error);
        } else if (req.file.path) {
            fs.unlinkSync(req.file.path);
        }

        res.status(500).json({ error: 'Failed to upload document' });
    }
});

// Delete lease document
app.delete('/api/leases/:id/document', requireAuth, async (req, res) => {
    const { id } = req.params;

    try {
        const pool = await poolPromise;

        // Verify lease ownership and get document info
        const result = await pool.request()
            .input('id', sql.Int, id)
            .input('ownerId', sql.Int, req.ownerId)
            .query(`SELECT l.document_filename FROM leases l
                    LEFT JOIN properties p ON l.property_id = p.id
                    LEFT JOIN companies c ON p.company_id = c.id
                    WHERE l.id = @id AND (p.owner_id = @ownerId OR c.owner_id = @ownerId)`);

        if (result.recordset.length === 0) {
            return res.status(403).json({ error: 'Not authorized to delete document from this lease' });
        }

        const lease = result.recordset[0];

        if (!lease || !lease.document_filename) {
            return res.status(404).json({ error: 'No document found' });
        }

        // Delete file
        if (USE_AZURE_STORAGE) {
            try {
                const blobClient = containerClient.getBlobClient(lease.document_filename);
                await blobClient.deleteIfExists();
            } catch (error) {
                console.error('Error deleting blob:', error);
            }
        } else {
            const filePath = path.join(uploadsDir, lease.document_filename);
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
        }

        // Update lease
        await pool.request()
            .input('id', sql.Int, id)
            .query(`UPDATE leases SET document_filename = NULL,
                    document_original_name = NULL, document_uploaded_at = NULL
                    WHERE id = @id`);

        res.json({ message: 'Document deleted successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== EXPENSES ROUTES ====================
app.get('/api/expenses', requireAuth, async (req, res) => {
    try {
        const pool = await poolPromise;
        const result = await pool.request()
            .input('ownerId', sql.Int, req.ownerId)
            .query(`
                SELECT e.*, p.address1 as property_address, c.name as company_name
                FROM expenses e
                LEFT JOIN properties p ON e.property_id = p.id
                LEFT JOIN companies c ON e.company_id = c.id
                LEFT JOIN companies pc ON p.company_id = pc.id
                WHERE c.owner_id = @ownerId OR p.owner_id = @ownerId OR pc.owner_id = @ownerId
                ORDER BY e.date DESC
            `);
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/expenses', requireAuth, async (req, res) => {
    const { date, property_id, company_id, category, amount, description } = req.body;
    try {
        const pool = await poolPromise;

        // Verify ownership of property or company
        if (property_id) {
            const ownerCheck = await pool.request()
                .input('propertyId', sql.Int, property_id)
                .input('ownerId', sql.Int, req.ownerId)
                .query(`SELECT p.id FROM properties p
                        LEFT JOIN companies c ON p.company_id = c.id
                        WHERE p.id = @propertyId AND (p.owner_id = @ownerId OR c.owner_id = @ownerId)`);

            if (ownerCheck.recordset.length === 0) {
                return res.status(403).json({ error: 'Not authorized to add expense to this property' });
            }
        }

        if (company_id) {
            const ownerCheck = await pool.request()
                .input('companyId', sql.Int, company_id)
                .input('ownerId', sql.Int, req.ownerId)
                .query('SELECT id FROM companies WHERE id = @companyId AND owner_id = @ownerId');

            if (ownerCheck.recordset.length === 0) {
                return res.status(403).json({ error: 'Not authorized to add expense to this company' });
            }
        }

        const result = await pool.request()
            .input('date', sql.Date, date)
            .input('property_id', sql.Int, property_id || null)
            .input('company_id', sql.Int, company_id || null)
            .input('category', sql.NVarChar, category)
            .input('amount', sql.Decimal(18, 2), amount)
            .input('description', sql.NVarChar, description)
            .query(`INSERT INTO expenses (date, property_id, company_id, category, amount, description)
                    OUTPUT INSERTED.id
                    VALUES (@date, @property_id, @company_id, @category, @amount, @description)`);

        res.json({ id: result.recordset[0].id, message: 'Expense created successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/expenses/:id', requireAuth, async (req, res) => {
    const { date, property_id, company_id, category, amount, description } = req.body;
    const { id } = req.params;
    try {
        const pool = await poolPromise;

        // Verify expense ownership
        const ownerCheck = await pool.request()
            .input('id', sql.Int, id)
            .input('ownerId', sql.Int, req.ownerId)
            .query(`SELECT e.id FROM expenses e
                    LEFT JOIN properties p ON e.property_id = p.id
                    LEFT JOIN companies c ON e.company_id = c.id
                    LEFT JOIN companies pc ON p.company_id = pc.id
                    WHERE e.id = @id AND (c.owner_id = @ownerId OR p.owner_id = @ownerId OR pc.owner_id = @ownerId)`);

        if (ownerCheck.recordset.length === 0) {
            return res.status(403).json({ error: 'Not authorized to modify this expense' });
        }

        await pool.request()
            .input('id', sql.Int, id)
            .input('date', sql.Date, date)
            .input('property_id', sql.Int, property_id || null)
            .input('company_id', sql.Int, company_id || null)
            .input('category', sql.NVarChar, category)
            .input('amount', sql.Decimal(18, 2), amount)
            .input('description', sql.NVarChar, description)
            .query(`UPDATE expenses SET date = @date, property_id = @property_id,
                    company_id = @company_id, category = @category, amount = @amount,
                    description = @description WHERE id = @id`);

        res.json({ message: 'Expense updated successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/expenses/:id', requireAuth, async (req, res) => {
    const { id } = req.params;
    try {
        const pool = await poolPromise;

        // Verify expense ownership
        const ownerCheck = await pool.request()
            .input('id', sql.Int, id)
            .input('ownerId', sql.Int, req.ownerId)
            .query(`SELECT e.id FROM expenses e
                    LEFT JOIN properties p ON e.property_id = p.id
                    LEFT JOIN companies c ON e.company_id = c.id
                    LEFT JOIN companies pc ON p.company_id = pc.id
                    WHERE e.id = @id AND (c.owner_id = @ownerId OR p.owner_id = @ownerId OR pc.owner_id = @ownerId)`);

        if (ownerCheck.recordset.length === 0) {
            return res.status(403).json({ error: 'Not authorized to delete this expense' });
        }

        await pool.request()
            .input('id', sql.Int, id)
            .query('DELETE FROM expenses WHERE id = @id');

        res.json({ message: 'Expense deleted successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==================== EXPENSE CATEGORIES ROUTES ====================
app.get('/api/expense-categories', requireAuth, async (req, res) => {
    try {
        const pool = await poolPromise;
        const result = await pool.request()
            .input('ownerId', sql.Int, req.ownerId)
            .query('SELECT * FROM expense_categories WHERE owner_id = @ownerId OR owner_id IS NULL ORDER BY name ASC');
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/expense-categories', requireAuth, async (req, res) => {
    const { name } = req.body;
    try {
        const pool = await poolPromise;

        // Check if category already exists for this owner
        const existing = await pool.request()
            .input('name', sql.NVarChar, name)
            .input('ownerId', sql.Int, req.ownerId)
            .query('SELECT id FROM expense_categories WHERE name = @name AND owner_id = @ownerId');

        if (existing.recordset.length > 0) {
            return res.json({ id: existing.recordset[0].id, message: 'Category already exists' });
        }

        const result = await pool.request()
            .input('name', sql.NVarChar, name)
            .input('owner_id', sql.Int, req.ownerId)
            .query(`INSERT INTO expense_categories (name, owner_id)
                    OUTPUT INSERTED.id
                    VALUES (@name, @owner_id)`);

        res.json({ id: result.recordset[0].id, message: 'Category created successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==================== RENT PAYMENTS ROUTES ====================
app.get('/api/payments', requireAuth, async (req, res) => {
    const { month, year, tenant_id } = req.query;
    try {
        const pool = await poolPromise;
        let query = `SELECT p.*, t.name as tenant_name, t.phone as tenant_phone,
                     pr.address1 as property_address, l.rent as expected_rent
                     FROM rent_payments p
                     LEFT JOIN tenants t ON p.tenant_id = t.id
                     LEFT JOIN leases l ON l.tenant_id = p.tenant_id AND l.end_date >= CAST(GETDATE() AS DATE)
                     LEFT JOIN properties pr ON l.property_id = pr.id
                     LEFT JOIN companies c ON pr.company_id = c.id`;

        let conditions = ['(pr.owner_id = @ownerId OR c.owner_id = @ownerId)'];

        if (month && year) {
            conditions.push(`MONTH(p.payment_date) = @month AND YEAR(p.payment_date) = @year`);
        } else if (year) {
            conditions.push(`YEAR(p.payment_date) = @year`);
        }

        if (tenant_id) {
            conditions.push(`p.tenant_id = @tenant_id`);
        }

        query += ' WHERE ' + conditions.join(' AND ');
        query += ' ORDER BY p.payment_date DESC';

        const request = pool.request();
        request.input('ownerId', sql.Int, req.ownerId);
        if (month && year) {
            request.input('month', sql.Int, parseInt(month));
            request.input('year', sql.Int, parseInt(year));
        } else if (year) {
            request.input('year', sql.Int, parseInt(year));
        }
        if (tenant_id) {
            request.input('tenant_id', sql.Int, parseInt(tenant_id));
        }

        const result = await request.query(query);
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get payment summary - MUST be before /:id route
app.get('/api/payments/summary', requireAuth, async (req, res) => {
    const { month, year } = req.query;
    const today = new Date();
    const currentYear = year || today.getFullYear();
    const isYearlyView = year && !month;

    try {
        const pool = await poolPromise;

        // Get total expected rent for owner's properties (multiply by 12 for yearly view)
        const expectedResult = await pool.request()
            .input('ownerId', sql.Int, req.ownerId)
            .query(`SELECT SUM(l.rent) as expected_total
                    FROM leases l
                    LEFT JOIN properties p ON l.property_id = p.id
                    LEFT JOIN companies c ON p.company_id = c.id
                    WHERE l.end_date >= CAST(GETDATE() AS DATE)
                    AND (p.owner_id = @ownerId OR c.owner_id = @ownerId)`);

        let collectedResult, methodsResult;

        if (isYearlyView) {
            // Yearly view - get all payments for the year for owner's tenants
            collectedResult = await pool.request()
                .input('year', sql.Int, parseInt(currentYear))
                .input('ownerId', sql.Int, req.ownerId)
                .query(`SELECT SUM(rp.amount) as collected_total, COUNT(*) as payment_count
                        FROM rent_payments rp
                        LEFT JOIN tenants t ON rp.tenant_id = t.id
                        LEFT JOIN properties p ON t.property_id = p.id
                        LEFT JOIN companies c ON p.company_id = c.id
                        WHERE YEAR(rp.payment_date) = @year
                        AND (p.owner_id = @ownerId OR c.owner_id = @ownerId)`);

            methodsResult = await pool.request()
                .input('year', sql.Int, parseInt(currentYear))
                .input('ownerId', sql.Int, req.ownerId)
                .query(`SELECT rp.payment_method, SUM(rp.amount) as total, COUNT(*) as count
                        FROM rent_payments rp
                        LEFT JOIN tenants t ON rp.tenant_id = t.id
                        LEFT JOIN properties p ON t.property_id = p.id
                        LEFT JOIN companies c ON p.company_id = c.id
                        WHERE YEAR(rp.payment_date) = @year
                        AND (p.owner_id = @ownerId OR c.owner_id = @ownerId)
                        GROUP BY rp.payment_method`);
        } else {
            // Monthly view
            const currentMonth = month || (today.getMonth() + 1);

            collectedResult = await pool.request()
                .input('month', sql.Int, parseInt(currentMonth))
                .input('year', sql.Int, parseInt(currentYear))
                .input('ownerId', sql.Int, req.ownerId)
                .query(`SELECT SUM(rp.amount) as collected_total, COUNT(*) as payment_count
                        FROM rent_payments rp
                        LEFT JOIN tenants t ON rp.tenant_id = t.id
                        LEFT JOIN properties p ON t.property_id = p.id
                        LEFT JOIN companies c ON p.company_id = c.id
                        WHERE MONTH(rp.payment_date) = @month AND YEAR(rp.payment_date) = @year
                        AND (p.owner_id = @ownerId OR c.owner_id = @ownerId)`);

            methodsResult = await pool.request()
                .input('month', sql.Int, parseInt(currentMonth))
                .input('year', sql.Int, parseInt(currentYear))
                .input('ownerId', sql.Int, req.ownerId)
                .query(`SELECT rp.payment_method, SUM(rp.amount) as total, COUNT(*) as count
                        FROM rent_payments rp
                        LEFT JOIN tenants t ON rp.tenant_id = t.id
                        LEFT JOIN properties p ON t.property_id = p.id
                        LEFT JOIN companies c ON p.company_id = c.id
                        WHERE MONTH(rp.payment_date) = @month AND YEAR(rp.payment_date) = @year
                        AND (p.owner_id = @ownerId OR c.owner_id = @ownerId)
                        GROUP BY rp.payment_method`);
        }

        const expected = expectedResult.recordset[0];
        const collected = collectedResult.recordset[0];

        // For yearly view, multiply expected by 12 (months in a year)
        const expectedTotal = isYearlyView
            ? (expected.expected_total || 0) * 12
            : (expected.expected_total || 0);

        res.json({
            expectedTotal: expectedTotal,
            collectedTotal: collected.collected_total || 0,
            paymentCount: collected.payment_count || 0,
            outstanding: expectedTotal - (collected.collected_total || 0),
            paymentMethods: methodsResult.recordset
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get single payment by ID
app.get('/api/payments/:id', requireAuth, async (req, res) => {
    const { id } = req.params;
    try {
        const pool = await poolPromise;
        const result = await pool.request()
            .input('id', sql.Int, id)
            .input('ownerId', sql.Int, req.ownerId)
            .query(`SELECT p.*, t.name as tenant_name, t.phone as tenant_phone,
                    pr.address1 as property_address, l.rent as expected_rent
                    FROM rent_payments p
                    LEFT JOIN tenants t ON p.tenant_id = t.id
                    LEFT JOIN leases l ON l.tenant_id = p.tenant_id AND l.end_date >= CAST(GETDATE() AS DATE)
                    LEFT JOIN properties pr ON l.property_id = pr.id
                    LEFT JOIN companies c ON pr.company_id = c.id
                    WHERE p.id = @id AND (pr.owner_id = @ownerId OR c.owner_id = @ownerId)`);

        if (result.recordset.length === 0) {
            return res.status(404).json({ error: 'Payment not found' });
        }
        res.json(result.recordset[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/payments', requireAuth, async (req, res) => {
    const { tenant_id, payment_date, amount, payment_method, check_number, paid_in_full, notes } = req.body;
    try {
        const pool = await poolPromise;

        // Verify tenant ownership
        const ownerCheck = await pool.request()
            .input('tenantId', sql.Int, tenant_id)
            .input('ownerId', sql.Int, req.ownerId)
            .query(`SELECT t.id FROM tenants t
                    LEFT JOIN properties p ON t.property_id = p.id
                    LEFT JOIN companies c ON p.company_id = c.id
                    WHERE t.id = @tenantId AND (p.owner_id = @ownerId OR c.owner_id = @ownerId)`);

        if (ownerCheck.recordset.length === 0) {
            return res.status(403).json({ error: 'Not authorized to add payment for this tenant' });
        }

        const result = await pool.request()
            .input('tenant_id', sql.Int, tenant_id)
            .input('payment_date', sql.Date, payment_date)
            .input('amount', sql.Decimal(18, 2), amount)
            .input('payment_method', sql.NVarChar, payment_method)
            .input('check_number', sql.NVarChar, check_number || '')
            .input('paid_in_full', sql.Bit, paid_in_full ? 1 : 0)
            .input('notes', sql.NVarChar, notes || '')
            .query(`INSERT INTO rent_payments (tenant_id, payment_date, amount, payment_method, check_number, paid_in_full, notes)
                    OUTPUT INSERTED.id
                    VALUES (@tenant_id, @payment_date, @amount, @payment_method, @check_number, @paid_in_full, @notes)`);

        res.json({ id: result.recordset[0].id, message: 'Payment recorded successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/payments/:id', requireAuth, async (req, res) => {
    const { tenant_id, payment_date, amount, payment_method, check_number, paid_in_full, notes } = req.body;
    const { id } = req.params;
    try {
        const pool = await poolPromise;

        // Verify payment ownership through tenant
        const ownerCheck = await pool.request()
            .input('id', sql.Int, id)
            .input('ownerId', sql.Int, req.ownerId)
            .query(`SELECT rp.id FROM rent_payments rp
                    LEFT JOIN tenants t ON rp.tenant_id = t.id
                    LEFT JOIN properties p ON t.property_id = p.id
                    LEFT JOIN companies c ON p.company_id = c.id
                    WHERE rp.id = @id AND (p.owner_id = @ownerId OR c.owner_id = @ownerId)`);

        if (ownerCheck.recordset.length === 0) {
            return res.status(403).json({ error: 'Not authorized to modify this payment' });
        }

        await pool.request()
            .input('id', sql.Int, id)
            .input('tenant_id', sql.Int, tenant_id)
            .input('payment_date', sql.Date, payment_date)
            .input('amount', sql.Decimal(18, 2), amount)
            .input('payment_method', sql.NVarChar, payment_method)
            .input('check_number', sql.NVarChar, check_number || '')
            .input('paid_in_full', sql.Bit, paid_in_full ? 1 : 0)
            .input('notes', sql.NVarChar, notes || '')
            .query(`UPDATE rent_payments SET tenant_id = @tenant_id, payment_date = @payment_date,
                    amount = @amount, payment_method = @payment_method, check_number = @check_number,
                    paid_in_full = @paid_in_full, notes = @notes WHERE id = @id`);

        res.json({ message: 'Payment updated successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/payments/:id', requireAuth, async (req, res) => {
    const { id } = req.params;
    try {
        const pool = await poolPromise;

        // Verify payment ownership through tenant
        const ownerCheck = await pool.request()
            .input('id', sql.Int, id)
            .input('ownerId', sql.Int, req.ownerId)
            .query(`SELECT rp.id FROM rent_payments rp
                    LEFT JOIN tenants t ON rp.tenant_id = t.id
                    LEFT JOIN properties p ON t.property_id = p.id
                    LEFT JOIN companies c ON p.company_id = c.id
                    WHERE rp.id = @id AND (p.owner_id = @ownerId OR c.owner_id = @ownerId)`);

        if (ownerCheck.recordset.length === 0) {
            return res.status(403).json({ error: 'Not authorized to delete this payment' });
        }

        await pool.request()
            .input('id', sql.Int, id)
            .query('DELETE FROM rent_payments WHERE id = @id');

        res.json({ message: 'Payment deleted successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==================== DASHBOARD/REPORTS ROUTES ====================
app.get('/api/dashboard', requireAuth, async (req, res) => {
    try {
        const pool = await poolPromise;
        const today = new Date();
        const currentMonth = today.getMonth() + 1;
        const currentYear = today.getFullYear();
        const ownerId = req.ownerId;

        // Get all dashboard stats for this owner's properties
        const propertiesCount = await pool.request()
            .input('ownerId', sql.Int, ownerId)
            .query(`SELECT COUNT(*) as total_properties
                    FROM properties p
                    LEFT JOIN companies c ON p.company_id = c.id
                    WHERE p.owner_id = @ownerId OR c.owner_id = @ownerId`);

        // Count tenants with active leases (lease end_date >= today)
        const activeTenantsCount = await pool.request()
            .input('ownerId', sql.Int, ownerId)
            .query(`SELECT COUNT(DISTINCT t.id) as active_tenants
                    FROM tenants t
                    INNER JOIN leases l ON t.id = l.tenant_id
                    INNER JOIN properties p ON l.property_id = p.id
                    LEFT JOIN companies c ON p.company_id = c.id
                    WHERE l.end_date >= CAST(GETDATE() AS DATE)
                    AND (p.owner_id = @ownerId OR c.owner_id = @ownerId)`);

        const activeLeases = await pool.request()
            .input('ownerId', sql.Int, ownerId)
            .query(`SELECT COUNT(*) as active_leases
                    FROM leases l
                    INNER JOIN properties p ON l.property_id = p.id
                    LEFT JOIN companies c ON p.company_id = c.id
                    WHERE l.end_date >= CAST(GETDATE() AS DATE)
                    AND (p.owner_id = @ownerId OR c.owner_id = @ownerId)`);
        const monthlyRent = await pool.request()
            .input('ownerId', sql.Int, ownerId)
            .query(`SELECT SUM(l.rent) as monthly_rent
                    FROM leases l
                    INNER JOIN properties p ON l.property_id = p.id
                    LEFT JOIN companies c ON p.company_id = c.id
                    WHERE l.end_date >= CAST(GETDATE() AS DATE)
                    AND (p.owner_id = @ownerId OR c.owner_id = @ownerId)`);
        const monthlyExpenses = await pool.request()
            .input('month', sql.Int, currentMonth)
            .input('year', sql.Int, currentYear)
            .input('ownerId', sql.Int, ownerId)
            .query(`SELECT SUM(e.amount) as monthly_expenses
                    FROM expenses e
                    LEFT JOIN properties p ON e.property_id = p.id
                    LEFT JOIN companies c ON e.company_id = c.id
                    LEFT JOIN companies pc ON p.company_id = pc.id
                    WHERE MONTH(e.date) = @month AND YEAR(e.date) = @year
                    AND (c.owner_id = @ownerId OR p.owner_id = @ownerId OR pc.owner_id = @ownerId)`);
        const expiringLeases = await pool.request()
            .input('ownerId', sql.Int, ownerId)
            .query(`SELECT COUNT(*) as expiring_leases
                    FROM leases l
                    INNER JOIN properties p ON l.property_id = p.id
                    LEFT JOIN companies c ON p.company_id = c.id
                    WHERE l.end_date BETWEEN CAST(GETDATE() AS DATE) AND DATEADD(day, 30, CAST(GETDATE() AS DATE))
                    AND (p.owner_id = @ownerId OR c.owner_id = @ownerId)`);

        res.json({
            totalProperties: propertiesCount.recordset[0].total_properties,
            activeTenants: activeTenantsCount.recordset[0].active_tenants,
            activeLeases: activeLeases.recordset[0].active_leases,
            monthlyRent: monthlyRent.recordset[0].monthly_rent || 0,
            monthlyExpenses: monthlyExpenses.recordset[0].monthly_expenses || 0,
            expiringLeases: expiringLeases.recordset[0].expiring_leases
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==================== REPORTS ROUTES ====================
// Get financial summary report
app.get('/api/reports', requireAuth, async (req, res) => {
    const { period } = req.query;
    const ownerId = req.ownerId;

    try {
        const pool = await poolPromise;
        const today = new Date();
        let startDate, endDate;

        // Calculate date range based on period
        switch (period) {
            case 'thisMonth':
                startDate = new Date(today.getFullYear(), today.getMonth(), 1);
                endDate = new Date(today.getFullYear(), today.getMonth() + 1, 0);
                break;
            case 'lastMonth':
                startDate = new Date(today.getFullYear(), today.getMonth() - 1, 1);
                endDate = new Date(today.getFullYear(), today.getMonth(), 0);
                break;
            case 'thisYear':
                startDate = new Date(today.getFullYear(), 0, 1);
                endDate = new Date(today.getFullYear(), 11, 31);
                break;
            case 'allTime':
            default:
                startDate = new Date(2000, 0, 1);
                endDate = new Date(2100, 11, 31);
                break;
        }

        // Get total income (rent payments)
        const incomeResult = await pool.request()
            .input('ownerId', sql.Int, ownerId)
            .input('startDate', sql.Date, startDate)
            .input('endDate', sql.Date, endDate)
            .query(`SELECT COALESCE(SUM(rp.amount), 0) as total_income
                    FROM rent_payments rp
                    LEFT JOIN tenants t ON rp.tenant_id = t.id
                    LEFT JOIN properties p ON t.property_id = p.id
                    LEFT JOIN companies c ON p.company_id = c.id
                    WHERE rp.payment_date BETWEEN @startDate AND @endDate
                    AND (p.owner_id = @ownerId OR c.owner_id = @ownerId)`);

        // Get total expenses
        const expenseResult = await pool.request()
            .input('ownerId', sql.Int, ownerId)
            .input('startDate', sql.Date, startDate)
            .input('endDate', sql.Date, endDate)
            .query(`SELECT COALESCE(SUM(e.amount), 0) as total_expenses
                    FROM expenses e
                    LEFT JOIN properties p ON e.property_id = p.id
                    LEFT JOIN companies c ON e.company_id = c.id
                    LEFT JOIN companies pc ON p.company_id = pc.id
                    WHERE e.date BETWEEN @startDate AND @endDate
                    AND (c.owner_id = @ownerId OR p.owner_id = @ownerId OR pc.owner_id = @ownerId)`);

        const totalIncome = parseFloat(incomeResult.recordset[0].total_income) || 0;
        const totalExpenses = parseFloat(expenseResult.recordset[0].total_expenses) || 0;
        const netProfit = totalIncome - totalExpenses;
        const roi = totalExpenses > 0 ? ((netProfit / totalExpenses) * 100).toFixed(1) : 0;

        res.json({
            totalIncome,
            totalExpenses,
            netProfit,
            roi
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get unpaid rent report - tenants who haven't paid for specific months
app.get('/api/reports/unpaid-rent', requireAuth, async (req, res) => {
    const ownerId = req.ownerId;

    try {
        const pool = await poolPromise;
        const today = new Date();

        // Get all active leases with tenant info
        const leasesResult = await pool.request()
            .input('ownerId', sql.Int, ownerId)
            .query(`SELECT l.id as lease_id, l.rent as expected_rent, l.start_date, l.end_date,
                           t.id as tenant_id, t.name as tenant_name, t.phone as tenant_phone, t.email as tenant_email,
                           p.address1 as property_address, p.city, p.state
                    FROM leases l
                    INNER JOIN tenants t ON l.tenant_id = t.id
                    INNER JOIN properties p ON l.property_id = p.id
                    LEFT JOIN companies c ON p.company_id = c.id
                    WHERE l.end_date >= CAST(GETDATE() AS DATE)
                    AND l.start_date <= CAST(GETDATE() AS DATE)
                    AND (p.owner_id = @ownerId OR c.owner_id = @ownerId)
                    ORDER BY t.name`);

        const unpaidRentList = [];

        // For each active lease, check which months are unpaid
        for (const lease of leasesResult.recordset) {
            // Get all payments for this tenant
            const paymentsResult = await pool.request()
                .input('tenantId', sql.Int, lease.tenant_id)
                .query(`SELECT payment_date, amount, paid_in_full
                        FROM rent_payments
                        WHERE tenant_id = @tenantId
                        ORDER BY payment_date DESC`);

            const payments = paymentsResult.recordset;

            // Check last 12 months for unpaid rent
            const leaseStartDate = new Date(lease.start_date);
            const leaseStartMonth = leaseStartDate.getUTCMonth();
            const leaseStartYear = leaseStartDate.getUTCFullYear();
            const currentMonth = today.getUTCMonth();
            const currentYear = today.getUTCFullYear();

            for (let i = 0; i < 12; i++) {
                // Calculate the month/year to check
                let checkMonth = currentMonth - i;
                let checkYear = currentYear;
                while (checkMonth < 0) {
                    checkMonth += 12;
                    checkYear -= 1;
                }

                // Skip if before lease start (compare year first, then month)
                if (checkYear < leaseStartYear || (checkYear === leaseStartYear && checkMonth < leaseStartMonth)) {
                    continue;
                }

                // Check if there's a payment for this month (use UTC to avoid timezone issues)
                const monthPayments = payments.filter(p => {
                    const paymentDate = new Date(p.payment_date);
                    return paymentDate.getUTCMonth() === checkMonth &&
                           paymentDate.getUTCFullYear() === checkYear;
                });

                const totalPaidThisMonth = monthPayments.reduce((sum, p) => sum + parseFloat(p.amount), 0);
                const expectedRent = parseFloat(lease.expected_rent);

                if (totalPaidThisMonth < expectedRent) {
                    // Create a date object for display (UTC)
                    const displayDate = new Date(Date.UTC(checkYear, checkMonth, 1));
                    const monthName = displayDate.toLocaleString('default', { month: 'long', year: 'numeric', timeZone: 'UTC' });
                    const amountDue = expectedRent - totalPaidThisMonth;

                    unpaidRentList.push({
                        tenant_id: lease.tenant_id,
                        tenant_name: lease.tenant_name,
                        tenant_phone: lease.tenant_phone,
                        tenant_email: lease.tenant_email,
                        property_address: `${lease.property_address}, ${lease.city}, ${lease.state}`,
                        month: monthName,
                        month_date: displayDate.toISOString(),
                        expected_rent: expectedRent,
                        amount_paid: totalPaidThisMonth,
                        amount_due: amountDue,
                        status: totalPaidThisMonth === 0 ? 'Not Paid' : 'Partial'
                    });
                }
            }
        }

        // Sort by month (most recent first) then by tenant name
        unpaidRentList.sort((a, b) => {
            const dateA = new Date(a.month_date);
            const dateB = new Date(b.month_date);
            if (dateB.getTime() !== dateA.getTime()) {
                return dateB.getTime() - dateA.getTime();
            }
            return a.tenant_name.localeCompare(b.tenant_name);
        });

        res.json(unpaidRentList);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Start server
async function startServer() {
    await initializeDatabase();

    app.listen(PORT, () => {
        console.log(`🚀 Server running on port ${PORT}`);
        console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
        console.log(`💾 Database: Azure SQL Database`);
        console.log(`📁 Storage: ${USE_AZURE_STORAGE ? 'Azure Blob Storage' : 'Local Storage'}`);
    });
}

startServer().catch(err => {
    console.error('Failed to start server:', err);
    process.exit(1);
});
