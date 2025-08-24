# Browser-Use API Server

This is an extensible API server for triggering various browser-use functionalities, including API documentation extraction.

## Quick Start

### Start Server

```bash
# Development mode (auto-restart)
npm run api-server:dev

# 或者
yarn api-server:dev

# Production mode
npm run api-server

# 或者
yarn api-server
```

Server runs on `http://localhost:3000` by default

## API Endpoints

### 1. Health Check

**GET** `/health`

Check server status.

**Response Example:**
```json
{
  "status": "ok",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

### 2. Get Available Task List

**GET** `/api/extract/tasks`

Get all available extraction tasks.

**Response Example:**
```json
{
  "success": true,
  "data": {
    "available_tasks": [
      {
        "name": "tickets",
        "description": "Extract HubSpot Tickets API documentation",
        "endpoint": "/api/extract/tickets",
        "method": "POST"
      },
      {
        "name": "custom",
        "description": "Extract custom API documentation",
        "endpoint": "/api/extract/custom",
        "method": "POST",
        "required_params": ["url", "userRequest"],
        "optional_params": []
      }
    ]
  },
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

### 3. Extract HubSpot Tickets API Documentation

**POST** `/api/extract/tickets`

Trigger HubSpot Tickets API documentation extraction task.

**Request Parameters:**
- `url` (optional): API documentation URL to extract, defaults to HubSpot Tickets API
- `userRequest` (optional): User request description, defaults to Tickets API extraction request

**Request Example:**
```bash
# Using default parameters
curl -X POST http://localhost:3000/api/extract/tickets \
  -H "Content-Type: application/json"

# Using custom parameters
curl -X POST http://localhost:3000/api/extract/tickets \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://developers.hubspot.com/docs/reference/api/crm/objects/tickets",
    "userRequest": "Extract detailed API documentation for Tickets API"
  }'
```

**Response Example:**
```json
{
  "success": true,
  "message": "Tickets API extraction completed successfully",
  "data": {
    // Extraction result data
  },
  "parameters": {
    "url": "https://developers.hubspot.com/docs/reference/api/crm/objects/tickets",
    "userRequest": "Default tickets extraction request"
  },
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

### 4. Custom API Documentation Extraction

**POST** `/api/extract/custom`

Extract API documentation from custom URL.

**Request Parameters:**
- `url` (required): API documentation URL to extract
- `userRequest` (required): User request description, specifying content to extract

**Request Example:**
```bash
curl -X POST http://localhost:3000/api/extract/custom \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://api.example.com/docs",
    "userRequest": "Extract detailed API documentation content for all endpoints from this documentation page. Focus on request/response schemas, parameters, and authentication methods."
  }'
```

**响应示例：**
```json
{
  "success": true,
  "message": "Custom extraction completed successfully",
  "data": {
    // Extraction result data
  },
  "parameters": {
    "url": "https://api.example.com/docs",
    "userRequest": "Extract detailed API documentation content..."
  },
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

## Error Handling

All API endpoints return a unified error format when errors occur:

```json
{
  "success": false,
  "message": "Error description",
  "error": "Detailed error information",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

## Extending New API Endpoints

To add new API endpoints, follow these steps:

1. Add new routes to `apiRouter` in `server/api-server.ts`
2. Implement corresponding processing logic
3. Update the task list returned by `/api/extract/tasks` endpoint
4. Update this documentation

### Example: Adding New Extraction Task

```typescript
// Add new route to apiRouter
apiRouter.post('/extract/new-task', async (req, res) => {
  try {
    // Implement new task logic
    const result = await newTaskFunction(req.body);
    
    res.json({
      success: true,
      message: 'New task completed successfully',
      data: result,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error in new task:', error);
    
    res.status(500).json({
      success: false,
      message: 'Failed to execute new task',
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }
});
```

## Environment Variables

Ensure necessary environment variables are configured in `.env` file:

```env
PORT=3000
AZURE_OPENAI_API_KEY=your_azure_openai_api_key
# Other necessary environment variables
```

## Notes

- Server supports CORS, accessible from any domain
- All API responses include timestamps
- Error messages are logged to console
- Supports JSON and URL-encoded request bodies
