// server.js - Node.js Express server with Azure SQL Database
require('dotenv').config();
const express = require('express');
const sql = require('mssql');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const { BlobServiceClient } = require('@azure/storage-blob');

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
app.use(cors());
app.use(express.static('public'));

if (!USE_AZURE_STORAGE) {
    app.use('/uploads', express.static(uploadsDir));
}

// PWA Routes
app.get('/manifest.json', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'manifest.json'));
});

app.get('/sw.js', (req, res) => {
    res.setHeader('Content-Type', 'application/javascript');
    res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});

// ==================== COMPANIES ROUTES ====================
app.get('/api/companies', async (req, res) => {
    try {
        const pool = await poolPromise;
        const result = await pool.request().query('SELECT * FROM companies ORDER BY name ASC');
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/companies', async (req, res) => {
    const { name, notes } = req.body;
    try {
        const pool = await poolPromise;
        const result = await pool.request()
            .input('name', sql.NVarChar, name)
            .input('notes', sql.NVarChar, notes || '')
            .query(`INSERT INTO companies (name, notes)
                    OUTPUT INSERTED.id
                    VALUES (@name, @notes)`);

        res.json({ id: result.recordset[0].id, message: 'Company created successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/companies/:id', async (req, res) => {
    const { name, notes } = req.body;
    const { id } = req.params;
    try {
        const pool = await poolPromise;
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

app.delete('/api/companies/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const pool = await poolPromise;
        await pool.request()
            .input('id', sql.Int, id)
            .query('DELETE FROM companies WHERE id = @id');

        res.json({ message: 'Company deleted successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==================== PROPERTIES ROUTES ====================
app.get('/api/properties', async (req, res) => {
    try {
        const pool = await poolPromise;
        const result = await pool.request().query(`
            SELECT p.*, c.name as company_name
            FROM properties p
            LEFT JOIN companies c ON p.company_id = c.id
            ORDER BY p.created_at DESC
        `);
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/properties', async (req, res) => {
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
            .query(`INSERT INTO properties (address1, city, state, zip, type, company_id, status, notes)
                    OUTPUT INSERTED.id
                    VALUES (@address1, @city, @state, @zip, @type, @company_id, @status, @notes)`);

        res.json({ id: result.recordset[0].id, message: 'Property created successfully' });
    } catch (err) {
        console.error('Error creating property:', err);
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/properties/:id', async (req, res) => {
    const { address1, city, state, zip, type, company_id, status, notes } = req.body;
    const { id } = req.params;
    try {
        const pool = await poolPromise;
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

app.delete('/api/properties/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const pool = await poolPromise;
        await pool.request()
            .input('id', sql.Int, id)
            .query('DELETE FROM properties WHERE id = @id');

        res.json({ message: 'Property deleted successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==================== TENANTS ROUTES ====================
app.get('/api/tenants', async (req, res) => {
    try {
        const pool = await poolPromise;
        const result = await pool.request().query(`
            SELECT t.*, p.address1 as property_address
            FROM tenants t
            LEFT JOIN properties p ON t.property_id = p.id
            ORDER BY t.created_at DESC
        `);
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/tenants', async (req, res) => {
    const { name, phone, email, floor, property_id, emergency_contact, emergency_phone, notes } = req.body;
    try {
        const pool = await poolPromise;
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

app.put('/api/tenants/:id', async (req, res) => {
    const { name, phone, email, floor, property_id, emergency_contact, emergency_phone, notes } = req.body;
    const { id } = req.params;
    try {
        const pool = await poolPromise;
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

app.delete('/api/tenants/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const pool = await poolPromise;
        await pool.request()
            .input('id', sql.Int, id)
            .query('DELETE FROM tenants WHERE id = @id');

        res.json({ message: 'Tenant deleted successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==================== LEASES ROUTES ====================
app.get('/api/leases', async (req, res) => {
    try {
        const pool = await poolPromise;
        const result = await pool.request().query(`
            SELECT l.*, t.name as tenant_name, p.address1 as property_address
            FROM leases l
            LEFT JOIN tenants t ON l.tenant_id = t.id
            LEFT JOIN properties p ON l.property_id = p.id
            ORDER BY l.start_date DESC
        `);
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/leases', async (req, res) => {
    const { property_id, tenant_id, start_date, end_date, rent, deposit, notes } = req.body;
    try {
        const pool = await poolPromise;
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

app.put('/api/leases/:id', async (req, res) => {
    const { property_id, tenant_id, start_date, end_date, rent, deposit, notes } = req.body;
    const { id } = req.params;
    try {
        const pool = await poolPromise;
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

app.delete('/api/leases/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const pool = await poolPromise;

        // Get lease document info first
        const result = await pool.request()
            .input('id', sql.Int, id)
            .query('SELECT document_filename FROM leases WHERE id = @id');

        const lease = result.recordset[0];

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
app.post('/api/leases/:id/upload', upload.single('document'), async (req, res) => {
    const { id } = req.params;

    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }

    try {
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

        const pool = await poolPromise;
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
app.delete('/api/leases/:id/document', async (req, res) => {
    const { id } = req.params;

    try {
        const pool = await poolPromise;

        const result = await pool.request()
            .input('id', sql.Int, id)
            .query('SELECT document_filename FROM leases WHERE id = @id');

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
app.get('/api/expenses', async (req, res) => {
    try {
        const pool = await poolPromise;
        const result = await pool.request().query(`
            SELECT e.*, p.address1 as property_address, c.name as company_name
            FROM expenses e
            LEFT JOIN properties p ON e.property_id = p.id
            LEFT JOIN companies c ON e.company_id = c.id
            ORDER BY e.date DESC
        `);
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/expenses', async (req, res) => {
    const { date, property_id, company_id, category, amount, description } = req.body;
    try {
        const pool = await poolPromise;
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

app.put('/api/expenses/:id', async (req, res) => {
    const { date, property_id, company_id, category, amount, description } = req.body;
    const { id } = req.params;
    try {
        const pool = await poolPromise;
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

app.delete('/api/expenses/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const pool = await poolPromise;
        await pool.request()
            .input('id', sql.Int, id)
            .query('DELETE FROM expenses WHERE id = @id');

        res.json({ message: 'Expense deleted successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==================== RENT PAYMENTS ROUTES ====================
app.get('/api/payments', async (req, res) => {
    const { month, year } = req.query;
    try {
        const pool = await poolPromise;
        let query = `SELECT p.*, t.name as tenant_name, t.phone as tenant_phone,
                     pr.address1 as property_address, l.rent as expected_rent
                     FROM rent_payments p
                     LEFT JOIN tenants t ON p.tenant_id = t.id
                     LEFT JOIN leases l ON l.tenant_id = p.tenant_id AND l.end_date >= CAST(GETDATE() AS DATE)
                     LEFT JOIN properties pr ON l.property_id = pr.id`;

        if (month && year) {
            // Filter by specific month and year
            query += ` WHERE MONTH(p.payment_date) = @month AND YEAR(p.payment_date) = @year`;
        } else if (year) {
            // Filter by year only (for yearly view)
            query += ` WHERE YEAR(p.payment_date) = @year`;
        }

        query += ' ORDER BY p.payment_date DESC';

        const request = pool.request();
        if (month && year) {
            request.input('month', sql.Int, parseInt(month));
            request.input('year', sql.Int, parseInt(year));
        } else if (year) {
            request.input('year', sql.Int, parseInt(year));
        }

        const result = await request.query(query);
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get payment summary - MUST be before /:id route
app.get('/api/payments/summary', async (req, res) => {
    const { month, year } = req.query;
    const today = new Date();
    const currentYear = year || today.getFullYear();
    const isYearlyView = year && !month;

    try {
        const pool = await poolPromise;

        // Get total expected rent (multiply by 12 for yearly view)
        const expectedResult = await pool.request()
            .query(`SELECT SUM(rent) as expected_total FROM leases WHERE end_date >= CAST(GETDATE() AS DATE)`);

        let collectedResult, methodsResult;

        if (isYearlyView) {
            // Yearly view - get all payments for the year
            collectedResult = await pool.request()
                .input('year', sql.Int, parseInt(currentYear))
                .query(`SELECT SUM(amount) as collected_total, COUNT(*) as payment_count
                        FROM rent_payments
                        WHERE YEAR(payment_date) = @year`);

            methodsResult = await pool.request()
                .input('year', sql.Int, parseInt(currentYear))
                .query(`SELECT payment_method, SUM(amount) as total, COUNT(*) as count
                        FROM rent_payments
                        WHERE YEAR(payment_date) = @year
                        GROUP BY payment_method`);
        } else {
            // Monthly view
            const currentMonth = month || (today.getMonth() + 1);

            collectedResult = await pool.request()
                .input('month', sql.Int, parseInt(currentMonth))
                .input('year', sql.Int, parseInt(currentYear))
                .query(`SELECT SUM(amount) as collected_total, COUNT(*) as payment_count
                        FROM rent_payments
                        WHERE MONTH(payment_date) = @month AND YEAR(payment_date) = @year`);

            methodsResult = await pool.request()
                .input('month', sql.Int, parseInt(currentMonth))
                .input('year', sql.Int, parseInt(currentYear))
                .query(`SELECT payment_method, SUM(amount) as total, COUNT(*) as count
                        FROM rent_payments
                        WHERE MONTH(payment_date) = @month AND YEAR(payment_date) = @year
                        GROUP BY payment_method`);
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
app.get('/api/payments/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const pool = await poolPromise;
        const result = await pool.request()
            .input('id', sql.Int, id)
            .query(`SELECT p.*, t.name as tenant_name, t.phone as tenant_phone,
                    pr.address1 as property_address, l.rent as expected_rent
                    FROM rent_payments p
                    LEFT JOIN tenants t ON p.tenant_id = t.id
                    LEFT JOIN leases l ON l.tenant_id = p.tenant_id AND l.end_date >= CAST(GETDATE() AS DATE)
                    LEFT JOIN properties pr ON l.property_id = pr.id
                    WHERE p.id = @id`);

        if (result.recordset.length === 0) {
            return res.status(404).json({ error: 'Payment not found' });
        }
        res.json(result.recordset[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/payments', async (req, res) => {
    const { tenant_id, payment_date, amount, payment_method, check_number, paid_in_full, notes } = req.body;
    try {
        const pool = await poolPromise;
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

app.put('/api/payments/:id', async (req, res) => {
    const { tenant_id, payment_date, amount, payment_method, check_number, paid_in_full, notes } = req.body;
    const { id } = req.params;
    try {
        const pool = await poolPromise;
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

app.delete('/api/payments/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const pool = await poolPromise;
        await pool.request()
            .input('id', sql.Int, id)
            .query('DELETE FROM rent_payments WHERE id = @id');

        res.json({ message: 'Payment deleted successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==================== DASHBOARD/REPORTS ROUTES ====================
app.get('/api/dashboard', async (req, res) => {
    try {
        const pool = await poolPromise;
        const today = new Date();
        const currentMonth = today.getMonth() + 1;
        const currentYear = today.getFullYear();

        // Get all dashboard stats
        const propertiesCount = await pool.request().query('SELECT COUNT(*) as total_properties FROM properties');

        // Count tenants with active leases (lease end_date >= today)
        const activeTenantsCount = await pool.request()
            .query(`SELECT COUNT(DISTINCT t.id) as active_tenants
                    FROM tenants t
                    INNER JOIN leases l ON t.id = l.tenant_id
                    WHERE l.end_date >= CAST(GETDATE() AS DATE)`);

        const activeLeases = await pool.request()
            .query(`SELECT COUNT(*) as active_leases FROM leases WHERE end_date >= CAST(GETDATE() AS DATE)`);
        const monthlyRent = await pool.request()
            .query(`SELECT SUM(rent) as monthly_rent FROM leases WHERE end_date >= CAST(GETDATE() AS DATE)`);
        const monthlyExpenses = await pool.request()
            .input('month', sql.Int, currentMonth)
            .input('year', sql.Int, currentYear)
            .query(`SELECT SUM(amount) as monthly_expenses FROM expenses
                    WHERE MONTH(date) = @month AND YEAR(date) = @year`);
        const expiringLeases = await pool.request()
            .query(`SELECT COUNT(*) as expiring_leases FROM leases
                    WHERE end_date BETWEEN CAST(GETDATE() AS DATE) AND DATEADD(day, 30, CAST(GETDATE() AS DATE))`);

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
