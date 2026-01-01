#!/usr/bin/env node

/**
 * Admin script to create owner accounts
 * Usage: node scripts/create-owner.js <email> <password> <name> [--admin]
 *
 * Examples:
 *   node scripts/create-owner.js admin@example.com password123 "Admin User" --admin
 *   node scripts/create-owner.js owner@company.com mypassword "John Doe"
 */

require('dotenv').config();
const sql = require('mssql');
const bcrypt = require('bcryptjs');

const args = process.argv.slice(2);

if (args.length < 3) {
    console.error('Usage: node scripts/create-owner.js <email> <password> <name> [--admin]');
    console.error('');
    console.error('Examples:');
    console.error('  node scripts/create-owner.js admin@example.com password123 "Admin User" --admin');
    console.error('  node scripts/create-owner.js owner@company.com mypassword "John Doe"');
    process.exit(1);
}

const email = args[0];
const password = args[1];
const name = args[2];
const isAdmin = args.includes('--admin');

const dbConfig = {
    user: process.env.AZURE_SQL_USER,
    password: process.env.AZURE_SQL_PASSWORD,
    server: process.env.AZURE_SQL_SERVER,
    database: process.env.AZURE_SQL_DATABASE,
    options: {
        encrypt: true,
        trustServerCertificate: false
    }
};

async function createOwner() {
    let pool;

    try {
        console.log('Connecting to database...');
        pool = await sql.connect(dbConfig);

        // Check if email already exists
        const existing = await pool.request()
            .input('email', sql.NVarChar, email)
            .query('SELECT id FROM owners WHERE email = @email');

        if (existing.recordset.length > 0) {
            console.error(`Error: An owner with email "${email}" already exists.`);
            process.exit(1);
        }

        // Hash the password
        const saltRounds = 10;
        const passwordHash = await bcrypt.hash(password, saltRounds);

        // Create the owner
        const result = await pool.request()
            .input('email', sql.NVarChar, email)
            .input('passwordHash', sql.NVarChar, passwordHash)
            .input('name', sql.NVarChar, name)
            .input('isAdmin', sql.Bit, isAdmin ? 1 : 0)
            .query(`
                INSERT INTO owners (email, password_hash, name, is_admin)
                OUTPUT INSERTED.id
                VALUES (@email, @passwordHash, @name, @isAdmin)
            `);

        const ownerId = result.recordset[0].id;

        console.log('');
        console.log('✅ Owner created successfully!');
        console.log('');
        console.log('Details:');
        console.log(`  ID:       ${ownerId}`);
        console.log(`  Email:    ${email}`);
        console.log(`  Name:     ${name}`);
        console.log(`  Is Admin: ${isAdmin ? 'Yes' : 'No'}`);
        console.log('');

    } catch (error) {
        console.error('Error creating owner:', error.message);
        process.exit(1);
    } finally {
        if (pool) {
            await pool.close();
        }
    }
}

createOwner();
