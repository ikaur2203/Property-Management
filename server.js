// server.js - Node.js Express server with SQLite database
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;

// Middleware
app.use(express.json());
app.use(cors());
app.use(express.static('public')); // Serve static files from public directory

// PWA Routes
app.get('/manifest.json', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'manifest.json'));
});

app.get('/sw.js', (req, res) => {
    res.setHeader('Content-Type', 'application/javascript');
    res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});

// Initialize SQLite database
const db = new sqlite3.Database('./property_management.db', (err) => {
    if (err) {
        console.error('Error opening database:', err.message);
    } else {
        console.log('Connected to SQLite database');
        initializeDatabase();
    }
});

// Initialize database tables
function initializeDatabase() {
    // Properties table
    db.run(`CREATE TABLE IF NOT EXISTS properties (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        address TEXT NOT NULL,
        type TEXT NOT NULL,
        purchase_price REAL NOT NULL,
        current_value REAL DEFAULT 0,
        mortgage REAL DEFAULT 0,
        status TEXT DEFAULT 'Available',
        notes TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Tenants table
    db.run(`CREATE TABLE IF NOT EXISTS tenants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        phone TEXT NOT NULL,
        email TEXT NOT NULL,
        property_id INTEGER,
        emergency_contact TEXT,
        emergency_phone TEXT,
        notes TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (property_id) REFERENCES properties (id)
    )`);

    // Leases table
    db.run(`CREATE TABLE IF NOT EXISTS leases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER NOT NULL,
        property_id INTEGER NOT NULL,
        start_date DATE NOT NULL,
        end_date DATE NOT NULL,
        rent REAL NOT NULL,
        deposit REAL DEFAULT 0,
        terms TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (tenant_id) REFERENCES tenants (id),
        FOREIGN KEY (property_id) REFERENCES properties (id)
    )`);

    // Expenses table
    db.run(`CREATE TABLE IF NOT EXISTS expenses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date DATE NOT NULL,
        property_id INTEGER,
        category TEXT NOT NULL,
        amount REAL NOT NULL,
        description TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (property_id) REFERENCES properties (id)
    )`);

    console.log('Database tables initialized');
}

// PROPERTIES ROUTES
app.get('/api/properties', (req, res) => {
    db.all('SELECT * FROM properties ORDER BY created_at DESC', (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        res.json(rows);
    });
});

app.post('/api/properties', (req, res) => {
    const { address, type, purchase_price, current_value, mortgage, status, notes } = req.body;
    
    db.run(`INSERT INTO properties (address, type, purchase_price, current_value, mortgage, status, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [address, type, purchase_price, current_value || 0, mortgage || 0, status || 'Available', notes || ''],
        function(err) {
            if (err) {
                res.status(500).json({ error: err.message });
                return;
            }
            res.json({ id: this.lastID, message: 'Property created successfully' });
        }
    );
});

app.put('/api/properties/:id', (req, res) => {
    const { address, type, purchase_price, current_value, mortgage, status, notes } = req.body;
    const { id } = req.params;
    
    db.run(`UPDATE properties SET 
            address = ?, type = ?, purchase_price = ?, current_value = ?, 
            mortgage = ?, status = ?, notes = ?
            WHERE id = ?`,
        [address, type, purchase_price, current_value, mortgage, status, notes, id],
        function(err) {
            if (err) {
                res.status(500).json({ error: err.message });
                return;
            }
            res.json({ message: 'Property updated successfully' });
        }
    );
});

app.delete('/api/properties/:id', (req, res) => {
    const { id } = req.params;
    
    db.run('DELETE FROM properties WHERE id = ?', [id], function(err) {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        res.json({ message: 'Property deleted successfully' });
    });
});

// TENANTS ROUTES
app.get('/api/tenants', (req, res) => {
    db.all(`SELECT t.*, p.address as property_address 
            FROM tenants t 
            LEFT JOIN properties p ON t.property_id = p.id 
            ORDER BY t.created_at DESC`, (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        res.json(rows);
    });
});

app.post('/api/tenants', (req, res) => {
    const { name, phone, email, property_id, emergency_contact, emergency_phone, notes } = req.body;
    
    db.run(`INSERT INTO tenants (name, phone, email, property_id, emergency_contact, emergency_phone, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [name, phone, email, property_id || null, emergency_contact || '', emergency_phone || '', notes || ''],
        function(err) {
            if (err) {
                res.status(500).json({ error: err.message });
                return;
            }
            res.json({ id: this.lastID, message: 'Tenant created successfully' });
        }
    );
});

app.put('/api/tenants/:id', (req, res) => {
    const { name, phone, email, property_id, emergency_contact, emergency_phone, notes } = req.body;
    const { id } = req.params;
    
    db.run(`UPDATE tenants SET 
            name = ?, phone = ?, email = ?, property_id = ?, 
            emergency_contact = ?, emergency_phone = ?, notes = ?
            WHERE id = ?`,
        [name, phone, email, property_id || null, emergency_contact, emergency_phone, notes, id],
        function(err) {
            if (err) {
                res.status(500).json({ error: err.message });
                return;
            }
            res.json({ message: 'Tenant updated successfully' });
        }
    );
});

app.delete('/api/tenants/:id', (req, res) => {
    const { id } = req.params;
    
    db.run('DELETE FROM tenants WHERE id = ?', [id], function(err) {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        res.json({ message: 'Tenant deleted successfully' });
    });
});

// LEASES ROUTES
app.get('/api/leases', (req, res) => {
    db.all(`SELECT l.*, t.name as tenant_name, p.address as property_address 
            FROM leases l 
            LEFT JOIN tenants t ON l.tenant_id = t.id 
            LEFT JOIN properties p ON l.property_id = p.id 
            ORDER BY l.created_at DESC`, (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        res.json(rows);
    });
});

app.post('/api/leases', (req, res) => {
    const { tenant_id, property_id, start_date, end_date, rent, deposit, terms } = req.body;
    
    db.run(`INSERT INTO leases (tenant_id, property_id, start_date, end_date, rent, deposit, terms)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [tenant_id, property_id, start_date, end_date, rent, deposit || 0, terms || ''],
        function(err) {
            if (err) {
                res.status(500).json({ error: err.message });
                return;
            }
            res.json({ id: this.lastID, message: 'Lease created successfully' });
        }
    );
});

app.put('/api/leases/:id', (req, res) => {
    const { tenant_id, property_id, start_date, end_date, rent, deposit, terms } = req.body;
    const { id } = req.params;
    
    db.run(`UPDATE leases SET 
            tenant_id = ?, property_id = ?, start_date = ?, end_date = ?, 
            rent = ?, deposit = ?, terms = ?
            WHERE id = ?`,
        [tenant_id, property_id, start_date, end_date, rent, deposit, terms, id],
        function(err) {
            if (err) {
                res.status(500).json({ error: err.message });
                return;
            }
            res.json({ message: 'Lease updated successfully' });
        }
    );
});

app.delete('/api/leases/:id', (req, res) => {
    const { id } = req.params;
    
    db.run('DELETE FROM leases WHERE id = ?', [id], function(err) {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        res.json({ message: 'Lease deleted successfully' });
    });
});

// EXPENSES ROUTES
app.get('/api/expenses', (req, res) => {
    db.all(`SELECT e.*, p.address as property_address 
            FROM expenses e 
            LEFT JOIN properties p ON e.property_id = p.id 
            ORDER BY e.date DESC`, (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        res.json(rows);
    });
});

app.post('/api/expenses', (req, res) => {
    const { date, property_id, category, amount, description } = req.body;
    
    db.run(`INSERT INTO expenses (date, property_id, category, amount, description)
            VALUES (?, ?, ?, ?, ?)`,
        [date, property_id || null, category, amount, description],
        function(err) {
            if (err) {
                res.status(500).json({ error: err.message });
                return;
            }
            res.json({ id: this.lastID, message: 'Expense created successfully' });
        }
    );
});

app.put('/api/expenses/:id', (req, res) => {
    const { date, property_id, category, amount, description } = req.body;
    const { id } = req.params;
    
    db.run(`UPDATE expenses SET 
            date = ?, property_id = ?, category = ?, amount = ?, description = ?
            WHERE id = ?`,
        [date, property_id || null, category, amount, description, id],
        function(err) {
            if (err) {
                res.status(500).json({ error: err.message });
                return;
            }
            res.json({ message: 'Expense updated successfully' });
        }
    );
});

app.delete('/api/expenses/:id', (req, res) => {
    const { id } = req.params;
    
    db.run('DELETE FROM expenses WHERE id = ?', [id], function(err) {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        res.json({ message: 'Expense deleted successfully' });
    });
});

// DASHBOARD/REPORTS ROUTES
app.get('/api/dashboard', (req, res) => {
    const today = new Date().toISOString().split('T')[0];
    const currentMonth = new Date().getMonth() + 1;
    const currentYear = new Date().getFullYear();
    
    // Get dashboard statistics
    db.get('SELECT COUNT(*) as total_properties FROM properties', (err, propertiesCount) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        
        db.get(`SELECT COUNT(*) as active_tenants FROM leases 
                WHERE end_date >= ?`, [today], (err, tenantsCount) => {
            if (err) {
                res.status(500).json({ error: err.message });
                return;
            }
            
            db.get(`SELECT SUM(rent) as monthly_rent FROM leases 
                    WHERE end_date >= ?`, [today], (err, rentSum) => {
                if (err) {
                    res.status(500).json({ error: err.message });
                    return;
                }
                
                db.get(`SELECT SUM(amount) as monthly_expenses FROM expenses 
                        WHERE strftime('%m', date) = ? AND strftime('%Y', date) = ?`,
                    [currentMonth.toString().padStart(2, '0'), currentYear.toString()], (err, expensesSum) => {
                    if (err) {
                        res.status(500).json({ error: err.message });
                        return;
                    }
                    
                    res.json({
                        totalProperties: propertiesCount.total_properties,
                        activeTenants: tenantsCount.active_tenants,
                        monthlyRent: rentSum.monthly_rent || 0,
                        monthlyExpenses: expensesSum.monthly_expenses || 0
                    });
                });
            });
        });
    });
});

app.get('/api/reports', (req, res) => {
    const { period } = req.query;
    let startDate, endDate;
    const today = new Date();
    
    switch (period) {
        case 'thisMonth':
            startDate = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().split('T')[0];
            endDate = new Date(today.getFullYear(), today.getMonth() + 1, 0).toISOString().split('T')[0];
            break;
        case 'lastMonth':
            startDate = new Date(today.getFullYear(), today.getMonth() - 1, 1).toISOString().split('T')[0];
            endDate = new Date(today.getFullYear(), today.getMonth(), 0).toISOString().split('T')[0];
            break;
        case 'thisYear':
            startDate = new Date(today.getFullYear(), 0, 1).toISOString().split('T')[0];
            endDate = new Date(today.getFullYear(), 11, 31).toISOString().split('T')[0];
            break;
        default:
            startDate = new Date(today.getFullYear(), 0, 1).toISOString().split('T')[0];
            endDate = today.toISOString().split('T')[0];
    }
    
    // Get expenses for the period
    db.get(`SELECT SUM(amount) as total_expenses FROM expenses 
            WHERE date BETWEEN ? AND ?`, [startDate, endDate], (err, expensesSum) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        
        // Get active leases and calculate income
        db.get(`SELECT SUM(rent) as monthly_rent FROM leases 
                WHERE end_date >= ?`, [today.toISOString().split('T')[0]], (err, rentSum) => {
            if (err) {
                res.status(500).json({ error: err.message });
                return;
            }
            
            // Get total investment
            db.get('SELECT SUM(purchase_price) as total_investment FROM properties', (err, investmentSum) => {
                if (err) {
                    res.status(500).json({ error: err.message });
                    return;
                }
                
                const monthsInPeriod = period === 'thisYear' ? 12 : 1;
                const totalIncome = (rentSum.monthly_rent || 0) * monthsInPeriod;
                const totalExpenses = expensesSum.total_expenses || 0;
                const netProfit = totalIncome - totalExpenses;
                const totalInvestment = investmentSum.total_investment || 0;
                const roi = totalInvestment > 0 ? ((netProfit / totalInvestment) * 100) : 0;
                
                res.json({
                    totalIncome,
                    totalExpenses,
                    netProfit,
                    roi: parseFloat(roi.toFixed(2))
                });
            });
        });
    });
});

// Serve the frontend
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Something went wrong!' });
});

// Start server
app.listen(PORT, () => {
    console.log(`🏠 Property Management Server running on port ${PORT}`);
    console.log(`📱 Access your PWA at http://localhost:${PORT}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🔄 Shutting down gracefully...');
    db.close((err) => {
        if (err) {
            console.error(err.message);
        } else {
            console.log('✅ Database connection closed');
        }
        process.exit(0);
    });
});