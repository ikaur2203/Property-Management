# Azure App Service Deployment Guide (with Azure SQL Database)

## Architecture Overview

This app uses Azure cloud services for a fully managed, scalable solution:

- **Azure SQL Database**: Managed SQL database (Basic tier - $5/month)
- **Azure Blob Storage**: Lease documents storage (scalable, persistent)
- **Azure App Service**: Node.js application hosting (Basic B1 - $13/month)

**Total Cost: ~$18-20/month**

---

## Prerequisites

1. **Azure Account**: [Create free account](https://azure.microsoft.com/free/)
2. **Azure CLI**: [Install here](https://docs.microsoft.com/cli/azure/install-azure-cli)
3. **Node.js 18+**: Already installed
4. **Git**: For deployment

---

## Step 1: Create Azure SQL Database

### Using Azure Portal:

1. Go to [Azure Portal](https://portal.azure.com)
2. Click **"Create a resource"** → Search for **"SQL Database"**
3. Fill in:
   - **Resource Group**: Create new → `property-management-rg`
   - **Database name**: `property-management-db`
   - **Server**: Click "Create new"
     - **Server name**: `property-mgmt-[yourname]` (must be globally unique)
     - **Location**: Choose closest to you (e.g., East US)
     - **Authentication**: SQL authentication
     - **Server admin login**: `propadmin`
     - **Password**: Create a strong password (save this!)
   - **Compute + storage**: Click "Configure database"
     - **Service tier**: Basic
     - **Max size**: 2 GB
     - **DTUs**: 5
     - Click "Apply"
4. Click **"Review + Create"** → **"Create"**

### Using Azure CLI:

```bash
# Login to Azure
az login

# Create resource group
az group create --name property-management-rg --location eastus

# Create SQL Server
az sql server create \
  --name property-mgmt-$(whoami) \
  --resource-group property-management-rg \
  --location eastus \
  --admin-user propadmin \
  --admin-password 'YourSecurePassword123!'

# Create SQL Database (Basic tier)
az sql db create \
  --resource-group property-management-rg \
  --server property-mgmt-$(whoami) \
  --name property-management-db \
  --service-objective Basic \
  --max-size 2GB

# Allow Azure services to access the server
az sql server firewall-rule create \
  --resource-group property-management-rg \
  --server property-mgmt-$(whoami) \
  --name AllowAzureServices \
  --start-ip-address 0.0.0.0 \
  --end-ip-address 0.0.0.0

# Allow your local IP (for testing)
MY_IP=$(curl -s ifconfig.me)
az sql server firewall-rule create \
  --resource-group property-management-rg \
  --server property-mgmt-$(whoami) \
  --name AllowMyIP \
  --start-ip-address $MY_IP \
  --end-ip-address $MY_IP
```

### Configure Firewall Rules:

**Important**: Allow Azure services and your IP to access the database.

**Portal Method**:
1. Go to your SQL Server → **Security** → **Networking**
2. Under **Firewall rules**:
   - Check **"Allow Azure services and resources to access this server"**
   - Click **"Add your client IPv4 address"** (for local testing)
3. Click **"Save"**

### Get Connection String:

**Portal Method**:
1. Go to your SQL Database → **Settings** → **Connection strings**
2. Copy the **ADO.NET** connection string
3. Replace `{your_password}` with your actual password

**Connection string format**:
```
Server=tcp:property-mgmt-yourname.database.windows.net,1433;Initial Catalog=property-management-db;Persist Security Info=False;User ID=propadmin;Password={your_password};MultipleActiveResultSets=False;Encrypt=True;TrustServerCertificate=False;Connection Timeout=30;
```

You'll need these values for environment variables:
- **Server**: `property-mgmt-yourname.database.windows.net`
- **Database**: `property-management-db`
- **User**: `propadmin`
- **Password**: Your password

---

## Step 2: Create Azure Storage Account

### Using Azure Portal:

1. Click **"Create a resource"** → Search for **"Storage account"**
2. Fill in:
   - **Resource Group**: `property-management-rg` (same as database)
   - **Storage account name**: `propmanagement[yourname]` (must be globally unique)
   - **Region**: Same as SQL Database
   - **Performance**: Standard
   - **Redundancy**: LRS (Locally-redundant storage) - cheapest option
3. Click **"Review + Create"** → **"Create"**

### Using Azure CLI:

```bash
# Create storage account
az storage account create \
  --name propmanagement$(whoami) \
  --resource-group property-management-rg \
  --location eastus \
  --sku Standard_LRS
```

### Get Connection String:

**Portal Method**:
1. Go to your Storage Account → **Security + networking** → **Access keys**
2. Click **"Show"** next to key1
3. Copy **Connection string**

**CLI Method**:
```bash
az storage account show-connection-string \
  --name propmanagement$(whoami) \
  --resource-group property-management-rg \
  --query connectionString --output tsv
```

---

## Step 3: Create Azure App Service

### Using Azure Portal:

1. **Create a resource** → **Web App**
2. Configure:
   - **Resource Group**: `property-management-rg` (same as above)
   - **Name**: `property-management-[yourname]` (becomes your URL)
   - **Publish**: Code
   - **Runtime stack**: Node 20 LTS
   - **Operating System**: Linux (recommended)
   - **Region**: Same as SQL Database and Storage
   - **Pricing**:
     - Free (F1) - for testing
     - Basic B1 - for production ($13/month)
3. Click **"Review + Create"** → **"Create"**

### Using Azure CLI:

```bash
# Create App Service Plan (Linux)
az appservice plan create \
  --name property-management-plan \
  --resource-group property-management-rg \
  --sku B1 \
  --is-linux

# Create Web App
az webapp create \
  --name property-management-$(whoami) \
  --resource-group property-management-rg \
  --plan property-management-plan \
  --runtime "NODE:20-lts"
```

---

## Step 4: Configure App Service Settings

### Application Settings (Environment Variables):

#### Using Portal:
1. Go to your **App Service**
2. **Configuration** → **Application settings** → **New application setting**
3. Add these settings:

| Name | Value | Notes |
|------|-------|-------|
| `NODE_ENV` | `production` | Required |
| `AZURE_SQL_SERVER` | `property-mgmt-yourname.database.windows.net` | From Step 1 |
| `AZURE_SQL_DATABASE` | `property-management-db` | Database name |
| `AZURE_SQL_USER` | `propadmin` | SQL admin username |
| `AZURE_SQL_PASSWORD` | `YourSecurePassword123!` | SQL admin password |
| `AZURE_STORAGE_CONNECTION_STRING` | [Your connection string from Step 2] | Required for file uploads |
| `AZURE_STORAGE_CONTAINER_NAME` | `lease-documents` | Optional (default) |
| `SCM_DO_BUILD_DURING_DEPLOYMENT` | `true` | Runs npm install |
| `WEBSITE_NODE_DEFAULT_VERSION` | `20-lts` | Node version |

4. Click **"Save"** at the top

#### Using CLI:
```bash
# Get your storage connection string
STORAGE_CONNECTION=$(az storage account show-connection-string \
  --name propmanagement$(whoami) \
  --resource-group property-management-rg \
  --query connectionString --output tsv)

# Set all app settings at once
az webapp config appsettings set \
  --name property-management-$(whoami) \
  --resource-group property-management-rg \
  --settings \
    NODE_ENV=production \
    AZURE_SQL_SERVER="property-mgmt-$(whoami).database.windows.net" \
    AZURE_SQL_DATABASE=property-management-db \
    AZURE_SQL_USER=propadmin \
    AZURE_SQL_PASSWORD='YourSecurePassword123!' \
    AZURE_STORAGE_CONNECTION_STRING="$STORAGE_CONNECTION" \
    AZURE_STORAGE_CONTAINER_NAME=lease-documents \
    SCM_DO_BUILD_DURING_DEPLOYMENT=true
```

### General Settings:

**Portal Method**:
1. **Configuration** → **General settings**
2. Set:
   - **Startup Command**: `node server.js`
   - **Always On**: Enable (prevents app from sleeping)

**CLI Method**:
```bash
az webapp config set \
  --name property-management-$(whoami) \
  --resource-group property-management-rg \
  --startup-file "node server.js" \
  --always-on true
```

---

## Step 5: Deploy Your Application

### Method 1: Local Git Deployment (Recommended)

```bash
# Navigate to your project directory
cd /Users/singh/Documents/Projects/Property-Management

# Install dependencies locally first
npm install

# Initialize git (if not already)
git init
git add .
git commit -m "Initial commit for Azure deployment with SQL Database"

# Get Azure Git URL
AZURE_GIT_URL=$(az webapp deployment source config-local-git \
  --name property-management-$(whoami) \
  --resource-group property-management-rg \
  --query url --output tsv)

# Add Azure as remote
git remote add azure $AZURE_GIT_URL

# Get deployment credentials (first time only)
az webapp deployment user set \
  --user-name your-username \
  --password your-secure-password

# Deploy!
git push azure master
```

### Method 2: GitHub Actions (For Continuous Deployment)

1. **Portal**: App Service → **Deployment Center** → **GitHub** → Authorize
2. Select your repository and branch
3. Azure automatically creates a GitHub Actions workflow
4. Every push to the branch auto-deploys

### Method 3: VS Code Extension

1. Install **Azure App Service** extension in VS Code
2. Sign in to Azure
3. Right-click your project folder → **Deploy to Web App**
4. Select your App Service → Confirm

### Method 4: ZIP Deploy

```bash
# Create deployment package (exclude dev files)
zip -r app.zip . -x "*.git*" "node_modules/*" "*.db" ".env" ".DS_Store"

# Deploy the zip
az webapp deploy \
  --name property-management-$(whoami) \
  --resource-group property-management-rg \
  --src-path app.zip \
  --type zip
```

---

## Step 6: Verify Deployment

### Check Application Logs:

**Portal**:
- App Service → **Monitoring** → **Log stream**

**CLI**:
```bash
az webapp log tail \
  --name property-management-$(whoami) \
  --resource-group property-management-rg
```

### Test Your App:

```bash
# Get your app URL
az webapp show \
  --name property-management-$(whoami) \
  --resource-group property-management-rg \
  --query defaultHostName --output tsv

# Open in browser
# https://property-management-yourname.azurewebsites.net
```

### Verify Connections:

Look for these console messages in logs:
- `✅ Connected to Azure SQL Database`
- `✅ Database tables initialized`
- `✅ Azure Blob Storage connected`
- `🚀 Server running on port 8080`

### Test Database:

1. Open your app in browser
2. Try adding a property
3. Add a tenant
4. Create a lease
5. Upload a lease document
6. Add a payment record

---

## Maintenance & Operations

### View Logs:
```bash
# Real-time logs
az webapp log tail --name property-management-$(whoami) \
  --resource-group property-management-rg

# Download logs
az webapp log download --name property-management-$(whoami) \
  --resource-group property-management-rg \
  --log-file logs.zip
```

### Restart App:
```bash
az webapp restart --name property-management-$(whoami) \
  --resource-group property-management-rg
```

### Scale Up (Change Pricing Tier):
```bash
# Scale to Standard S1 for better performance
az appservice plan update \
  --name property-management-plan \
  --resource-group property-management-rg \
  --sku S1
```

### Backup Database:

**Using Azure Portal**:
1. SQL Database → **Data management** → **Backups**
2. Azure automatically creates backups (7-35 days retention)
3. To restore: Click **Restore** → Select point in time

**Using CLI**:
```bash
# Create manual backup
az sql db copy \
  --resource-group property-management-rg \
  --server property-mgmt-$(whoami) \
  --name property-management-db \
  --dest-name property-management-db-backup
```

### Query Database Directly:

**Using Azure Portal**:
1. SQL Database → **Query editor**
2. Login with SQL authentication
3. Run queries directly in browser

**Using Azure Data Studio** (recommended):
1. Download [Azure Data Studio](https://docs.microsoft.com/sql/azure-data-studio/download)
2. Connect using:
   - Server: `property-mgmt-yourname.database.windows.net`
   - Authentication: SQL Login
   - Username: `propadmin`
   - Password: Your password
   - Database: `property-management-db`

---

## Troubleshooting

### App won't start:
```bash
# Check logs
az webapp log tail --name property-management-$(whoami) \
  --resource-group property-management-rg

# Common issues:
# - Missing environment variables (check Configuration)
# - Wrong SQL credentials
# - Firewall blocking connections
```

### Database connection fails:

**Error**: "Cannot open server 'property-mgmt-yourname' requested by the login"

**Fix**:
1. Go to SQL Server → **Security** → **Networking**
2. Enable **"Allow Azure services and resources to access this server"**
3. Save and restart app

### File uploads fail:
- Verify `AZURE_STORAGE_CONNECTION_STRING` is set correctly
- Check storage account firewall settings (allow all networks for testing)
- Check app logs for Azure Storage errors

### Performance Issues:
- Enable **Always On** (prevents cold starts)
- Upgrade to higher pricing tier (Basic B1+)
- Consider upgrading SQL Database to Standard tier

### Query Performance:
- Check query execution plans in Azure Portal
- Add indexes if needed
- Monitor DTU usage (Basic tier = 5 DTUs)

---

## Cost Breakdown

| Resource | Tier | Monthly Cost |
|----------|------|--------------|
| Azure SQL Database | Basic (5 DTUs, 2GB) | ~$5 |
| App Service Plan | Basic B1 | ~$13 |
| Storage Account | LRS (Standard) | ~$0.50 (for 5-10GB) |
| Bandwidth | First 100GB | Free |
| **Total** | | **~$18-20/month** |

### Cost Optimization Tips:
1. Use **Free F1** App Service tier for testing/development
2. Use **Basic** SQL Database tier for small workloads
3. Use **LRS** storage redundancy (cheapest)
4. Delete unused resources
5. Set up **auto-pause** for dev environments (not available on Basic tier)

---

## Security Checklist

- [ ] Enable HTTPS Only (automatic with Azure)
- [ ] Set strong SQL admin password
- [ ] Configure SQL firewall rules (restrict to Azure services)
- [ ] Use Azure Key Vault for secrets (optional, for production)
- [ ] Enable SQL Database auditing
- [ ] Set up Application Insights for monitoring
- [ ] Enable backup/restore for SQL Database
- [ ] Set up staging slots for testing (requires Standard tier)
- [ ] Configure CORS in server.js if needed

---

## Monitoring & Insights

### Enable Application Insights:

```bash
# Create Application Insights
az monitor app-insights component create \
  --app property-management-insights \
  --location eastus \
  --resource-group property-management-rg \
  --application-type web

# Get instrumentation key
INSTRUMENTATION_KEY=$(az monitor app-insights component show \
  --app property-management-insights \
  --resource-group property-management-rg \
  --query instrumentationKey --output tsv)

# Add to app settings
az webapp config appsettings set \
  --name property-management-$(whoami) \
  --resource-group property-management-rg \
  --settings APPINSIGHTS_INSTRUMENTATIONKEY=$INSTRUMENTATION_KEY
```

---

## Database Schema

The app automatically creates these tables on first run:

```sql
-- Properties table
CREATE TABLE properties (
    id INT IDENTITY(1,1) PRIMARY KEY,
    address NVARCHAR(500) NOT NULL,
    type NVARCHAR(100) NOT NULL,
    purchase_price DECIMAL(18,2) NOT NULL,
    current_value DECIMAL(18,2),
    status NVARCHAR(50) NOT NULL DEFAULT 'available',
    notes NVARCHAR(MAX),
    created_at DATETIME2 DEFAULT GETDATE()
)

-- Tenants table
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

-- Leases table
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

-- Expenses table
CREATE TABLE expenses (
    id INT IDENTITY(1,1) PRIMARY KEY,
    date DATE NOT NULL,
    property_id INT,
    category NVARCHAR(100) NOT NULL,
    amount DECIMAL(18,2) NOT NULL,
    description NVARCHAR(500) NOT NULL,
    created_at DATETIME2 DEFAULT GETDATE(),
    FOREIGN KEY (property_id) REFERENCES properties(id)
)

-- Rent Payments table
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
```

---

## Next Steps

1. ✅ Create Azure SQL Database
2. ✅ Create Storage Account
3. ✅ Create App Service
4. ✅ Configure environment variables
5. ✅ Deploy application
6. ✅ Test all features
7. 🔲 Set up custom domain
8. 🔲 Configure SSL certificate
9. 🔲 Enable Application Insights
10. 🔲 Set up automated backups
11. 🔲 Create staging environment

---

## Quick Reference Commands

```bash
# Deploy
git push azure master

# View logs
az webapp log tail -n property-management-$(whoami) -g property-management-rg

# Restart
az webapp restart -n property-management-$(whoami) -g property-management-rg

# Open in browser
az webapp browse -n property-management-$(whoami) -g property-management-rg

# SSH into app
az webapp ssh -n property-management-$(whoami) -g property-management-rg

# Query database
az sql db show-connection-string \
  -s property-mgmt-$(whoami) \
  -n property-management-db \
  -c ado.net
```

---

## Support

- **Azure Documentation**: https://docs.microsoft.com/azure/
- **Azure SQL Database**: https://docs.microsoft.com/azure/azure-sql/
- **Azure App Service**: https://docs.microsoft.com/azure/app-service/
- **Azure Support**: Create ticket in Azure Portal
- **Community**: Stack Overflow #azure

---

**Your app will be available at**:
`https://property-management-yourname.azurewebsites.net`

🎉 **Congratulations on deploying to Azure with Azure SQL Database!**
