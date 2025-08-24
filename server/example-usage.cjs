const http = require('http');

// API server configuration
const API_BASE_URL = 'http://localhost:3000';

// Helper function to send HTTP requests
function makeRequest(method, path, data = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, API_BASE_URL);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: method,
      headers: {
        'Content-Type': 'application/json',
      },
    };

    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        try {
          const jsonData = JSON.parse(body);
          resolve({ status: res.statusCode, data: jsonData });
        } catch (error) {
          resolve({ status: res.statusCode, data: body });
        }
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    if (data) {
      req.write(JSON.stringify(data));
    }

    req.end();
  });
}

// Test function
async function testAPI() {
  console.log('🚀 Starting API server tests...');
  console.log('=' .repeat(50));

  try {
    // 1. Health check
    // console.log('\n1. Test health check endpoint');
    // const healthResponse = await makeRequest('GET', '/health');
    // console.log('Status code:', healthResponse.status);
    // console.log('Response:', JSON.stringify(healthResponse.data, null, 2));

    // // 2. Get available task list
    // console.log('\n2. Get available task list');
    // const tasksResponse = await makeRequest('GET', '/api/extract/tasks');
    // console.log('Status code:', tasksResponse.status);
    // console.log('Response:', JSON.stringify(tasksResponse.data, null, 2));

    // // 3. Test Tickets API extraction (using default parameters)
    // console.log('\n3. Test Tickets API extraction (default parameters)');
    // const ticketsResponse = await makeRequest('POST', '/api/extract/tickets');
    // console.log('Status code:', ticketsResponse.status);
    // console.log('Response:', JSON.stringify(ticketsResponse.data, null, 2));

    // 4. Test Tickets API extraction (using custom parameters)
    console.log('\n4. Test Tickets API extraction (custom parameters)');
    const customTicketsData = {
      userRequest: 'https://www.zoho.com/bookings/help/api/v1/get-appointment.html only parse this one page and extract to OpenAPI Spec (JSON file)'
    };
    const customTicketsResponse = await makeRequest('POST', '/api/extract/tickets', customTicketsData);
    console.log('Status code:', customTicketsResponse.status);
    console.log('Request parameters:', JSON.stringify(customTicketsData, null, 2));
    console.log('Response:', JSON.stringify(customTicketsResponse.data, null, 2));

    // 5. Test custom extraction interface
    // console.log('\n5. Test custom extraction interface');
    // const customData = {
    //   url: 'https://jsonplaceholder.typicode.com/',
    //   userRequest: 'Extract API documentation content from this JSON placeholder API documentation page. Focus on available endpoints, request methods, and response formats.'
    // };
    // const customResponse = await makeRequest('POST', '/api/extract/custom', customData);
    // console.log('Status code:', customResponse.status);
    // console.log('Request parameters:', JSON.stringify(customData, null, 2));
    // console.log('Response:', JSON.stringify(customResponse.data, null, 2));

    // // 6. Test error handling (missing required parameters)
    // console.log('\n6. Test error handling (missing required parameters)');
    // const errorData = {
    //   url: 'https://example.com'
    //   // Intentionally not providing userRequest
    // };
    // const errorResponse = await makeRequest('POST', '/api/extract/custom', errorData);
    // console.log('Status code:', errorResponse.status);
    // console.log('Request parameters:', JSON.stringify(errorData, null, 2));
    // console.log('Response:', JSON.stringify(errorResponse.data, null, 2));

  } catch (error) {
    console.error('❌ Error occurred during testing:', error.message);
  }

  console.log('\n' + '=' .repeat(50));
  console.log('✅ API testing completed!');
}

// Run tests
if (require.main === module) {
  testAPI();
}

module.exports = { testAPI, makeRequest };
