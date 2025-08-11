# Property Management App

A comprehensive property management application built with Node.js, Express, and SQLite database. Perfect for managing up to 10 properties with tenants, leases, and expenses.

## Features

- **Property Management**: Track properties, purchase prices, mortgages, and current values
- **Tenant Management**: Store tenant information and contact details
- **Lease Management**: Manage lease agreements with automatic status tracking
- **Expense Tracking**: Categorize and track all property-related expenses
- **Financial Reports**: Generate income, expense, and ROI reports
- **Dashboard**: Real-time overview of your property portfolio

## Quick Start

### Prerequisites
- Node.js (version 14 or higher)
- npm (comes with Node.js)

### Installation

1. **Download/Clone the project files**
   ```bash
   # Create a new directory for your project
   mkdir property-management
   cd property-management
   ```

2. **Create the following files in your project directory:**
   - `server.js` (the Node.js backend code)
   - `package.json` (the dependencies file)
   - Create a `public` folder and put `index.html` (the frontend) inside it

3. **Install dependencies**
   ```bash
   npm install
   ```

4. **Start the application**
   ```bash
   npm start
   ```

5. **Access your app**
   Open your browser and go to: `http://localhost:3000`

## File Structure

```
property-management/
├── server.js              # Backend Node.js server
├── package.json           # Dependencies and scripts
├── property_management.db  # SQLite database (created automatically)
├── public/
│   └── index.html         # Frontend application
└── README.md              # This file
```

## Database

The app uses SQLite database which will be automatically created when you first run the server. The database file (`property_management.db`) will be created in your project root directory.

### Database Tables:
- **properties**: Store property information
- **tenants**: Store tenant details  
- **leases**: Manage lease agreements
- **expenses**: Track all expenses

## API Endpoints

### Properties
- `GET /api/properties` - Get all properties
- `POST /api/properties` - Create new property
- `PUT /api/properties/:id` - Update property
- `DELETE /api/properties/:id` - Delete property

### Tenants
- `GET /api/tenants` - Get all tenants
- `POST /api/tenants` - Create new tenant
- `PUT /api/tenants/:id` - Update tenant
- `DELETE /api/tenants/:id` - Delete tenant

### Leases
- `GET /api/leases` - Get all leases
- `POST /api/leases` - Create new lease
- `PUT /api/leases/:id` - Update lease
- `DELETE /api/leases/:id` - Delete lease

### Expenses
- `GET /api/expenses` - Get all expenses
- `POST /api/expenses` - Create new expense
- `PUT /api/expenses/:id` - Update expense
- `DELETE /api/expenses/:id` - Delete expense

### Reports
- `GET /api/dashboard` - Get dashboard statistics
- `GET /api/reports?period=thisMonth` - Get financial reports

## Deployment Options

### 1. Local Development
```bash
npm run dev  # Uses nodemon for auto-restart during development
```

### 2. VPS/Cloud Server (Recommended)
Deploy to any VPS like DigitalOcean, Linode, or AWS EC2:

1. Upload your files to the server
2. Install Node.js on the server
3. Run `npm install`
4. Use PM2 for production:
   ```bash
   npm install -g pm2
   pm2 start server.js --name "property-management"
   pm2 startup
   pm2 save
   ```

### 3. Free Hosting Options

#### Railway.app (Recommended for beginners)
1. Push your code to GitHub
2. Connect Railway to your GitHub repository
3. Railway will automatically deploy your app
4. Free tier includes database storage

#### Heroku
1. Install Heroku CLI
2. Create a Heroku app
3. Push your code to Heroku
4. Add environment variables if needed

#### Render.com
1. Connect your GitHub repository
2. Choose "Web Service"
3. Set build command: `npm install`
4. Set start command: `npm start`

## Environment Variables

For production deployment, you may want to set:

```bash
PORT=3000                    # Port number
NODE_ENV=production         # Environment mode
DATABASE_PATH=./property_management.db  # Database file path
```

## Backup

To backup your data, simply copy the `property_management.db` file. This contains all your properties, tenants, leases, and expenses.

## Troubleshooting

1. **Port already in use**: Change the PORT in server.js or set PORT environment variable
2. **Database errors**: Ensure write permissions in the app directory
3. **Module not found**: Run `npm install` to install dependencies

## Security Notes

For production deployment:
- Use HTTPS (SSL certificate)
- Set up proper firewall rules
- Consider adding authentication
- Regular database backups
- Update dependencies regularly

## Support

This application is designed for small property managers (up to 10 properties). For larger operations, consider upgrading to a more robust database like PostgreSQL.

## License

MIT License - Feel free to modify and use for your property management needs.