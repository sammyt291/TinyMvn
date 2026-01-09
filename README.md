# TinyMvn

A lightweight Node.js application for hosting Java projects and serving them as Maven/Gradle dependencies. No native build required - just `npm install`!

## Features

- **HTTP/HTTPS Support**: Switch between protocols via config
- **Auto Certificate Reload**: Automatically reloads when PEM files change (great for Let's Encrypt)
- **Web UI**: Login, upload, and browse project files
- **ZIP Upload**: Upload Java projects as ZIP files, auto-detects `src/main` folder
- **Maven Repository**: Serve projects as Maven/Gradle dependencies
- **File Browser**: View and explore uploaded project files
- **User Management**: Admin can create, delete, and reset passwords for users
- **Password Security**: Forces password change when using default credentials
- **Project Search & Sort**: Search projects by name/user, sort by date/user/name
- **Project Ownership**: Tracks which user uploaded each project

## Quick Start

```bash
# Install dependencies (no native builds required)
npm install

# Start the server
npm start
```

The server will start on `http://localhost:3000` by default.

### Default Credentials

- **Username**: `admin`
- **Password**: `admin123`

**Note**: You will be prompted to change the password on first login with default credentials.

## Configuration

Edit `config.json` to customize the application:

```json
{
  "server": {
    "port": 3000,
    "host": "0.0.0.0",
    "protocol": "http"
  },
  "https": {
    "keyPath": "./certs/server.key",
    "certPath": "./certs/server.crt",
    "watchCerts": true
  },
  "auth": {
    "sessionSecret": "change-this-to-a-secure-random-string",
    "users": [...],
    "defaultPassword": "admin123"
  },
  "storage": {
    "uploadDir": "./uploads",
    "projectsDir": "./projects",
    "tempDir": "./temp"
  },
  "repository": {
    "basePath": "/repo",
    "groupId": "com.example",
    "artifactId": "project"
  }
}
```

### Configuration Options

| Option | Description |
|--------|-------------|
| `server.port` | Port number to listen on |
| `server.host` | Host address to bind to |
| `server.protocol` | `http` or `https` |
| `https.keyPath` | Path to SSL private key PEM file |
| `https.certPath` | Path to SSL certificate PEM file |
| `https.watchCerts` | Auto-reload when certificates change |
| `auth.sessionSecret` | Secret for session encryption (change this!) |
| `auth.users` | Array of user objects with hashed passwords |
| `auth.defaultPassword` | Fallback password for quick setup |
| `storage.uploadDir` | Temporary upload directory |
| `storage.projectsDir` | Permanent project storage |
| `storage.tempDir` | Temp directory for extraction |
| `repository.basePath` | URL path for repository |
| `repository.groupId` | Default Maven groupId |

## HTTPS Setup

1. Set `protocol` to `https` in config.json
2. Place your certificate files:
   - `./certs/server.key` - Private key
   - `./certs/server.crt` - Certificate

```bash
# Generate self-signed certificates for testing
mkdir -p certs
openssl req -x509 -newkey rsa:4096 -keyout certs/server.key -out certs/server.crt -days 365 -nodes -subj "/CN=localhost"
```

The server automatically reloads certificates when they change (useful for Let's Encrypt auto-renewal).

## User Management

### Via Web UI (Recommended)

1. Log in as admin
2. Go to Settings (⚙️ button in header)
3. Use the User Management section to:
   - Add new users
   - Reset user passwords
   - Delete users (except admin)

### Via Command Line

Generate a password hash:

```bash
node scripts/hash-password.js yourpassword
```

Add the user to `config.json`:

```json
{
  "auth": {
    "users": [
      {
        "username": "admin",
        "password": "$2a$10$..."
      }
    ]
  }
}
```

## Uploading Projects

1. Log in at `http://localhost:3000`
2. Go to Files page
3. Drop or select a ZIP file containing your Java project
4. The app automatically finds the `src/main` folder

### Expected ZIP Structure

```
project.zip
└── my-project/
    ├── pom.xml (or build.gradle)
    └── src/
        └── main/
            └── java/
                └── ...
```

## Using as Maven Repository

After uploading a project, it's available as a Maven dependency.

### Maven (pom.xml)

```xml
<repositories>
  <repository>
    <id>custom-repo</id>
    <url>http://localhost:3000/repo</url>
  </repository>
</repositories>

<dependencies>
  <dependency>
    <groupId>com.example</groupId>
    <artifactId>your-project-name</artifactId>
    <version>1.0.0</version>
  </dependency>
</dependencies>
```

### Gradle (build.gradle)

```groovy
repositories {
    maven { url 'http://localhost:3000/repo' }
}

dependencies {
    implementation 'com.example:your-project-name:1.0.0'
}
```

## API Endpoints

### Authentication
- `GET /auth/login` - Login page
- `POST /auth/login` - Login handler
- `GET /auth/logout` - Logout
- `GET /auth/settings` - Settings page
- `GET /auth/me` - Get current user info
- `POST /auth/change-password` - Change password
- `GET /auth/users` - List users (admin only)
- `POST /auth/users` - Create user (admin only)
- `PUT /auth/users/:username/password` - Reset user password (admin only)
- `DELETE /auth/users/:username` - Delete user (admin only)

### Files
- `GET /files` - File manager UI
- `GET /files/api/projects` - List projects
- `GET /files/api/projects/:name` - Get project details
- `GET /files/api/projects/:name/file?path=...` - View file content
- `POST /files/api/upload` - Upload ZIP file
- `DELETE /files/api/projects/:name` - Delete project

### Repository
- `GET /repo` - Repository browser UI
- `GET /repo/api/artifacts` - List available artifacts
- `GET /repo/{groupId}/{artifactId}/{version}/{file}` - Serve artifact files

## Directory Structure

```
.
├── config.json          # Application configuration
├── package.json         # Dependencies
├── src/
│   ├── server.js        # Main server entry point
│   ├── routes/
│   │   ├── auth.js      # Authentication routes
│   │   ├── files.js     # File management routes
│   │   └── repo.js      # Repository routes
│   ├── middleware/
│   │   └── auth.js      # Auth middleware
│   └── utils/
│       ├── fileUtils.js # File utilities
│       └── password.js  # Password hashing
├── views/
│   ├── login.html       # Login page
│   ├── files.html       # File manager
│   ├── repo.html        # Repository browser
│   └── settings.html    # Settings & user management
├── public/              # Static assets
├── certs/               # SSL certificates (for HTTPS)
├── uploads/             # Temporary uploads
├── projects/            # Stored projects
└── temp/                # Temporary extraction
```

## License

MIT
