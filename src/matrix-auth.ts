import * as sdk from 'matrix-js-sdk';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables from .env file
dotenv.config({ path: path.join(__dirname, '..', '.env') });

async function authenticate() {
  const homeserver = process.env.MATRIX_HOMESERVER;
  const userId = process.env.MATRIX_USER_ID;
  const password = process.env.MATRIX_PASSWORD;

  if (!homeserver || !userId || !password) {
    console.error('Error: Matrix credentials not configured');
    console.error('Please set the following environment variables in .env:');
    console.error('  MATRIX_HOMESERVER (e.g., https://matrix.org)');
    console.error('  MATRIX_USER_ID (e.g., @username:matrix.org)');
    console.error('  MATRIX_PASSWORD');
    process.exit(1);
  }

  console.log(`Authenticating to Matrix...`);
  console.log(`Homeserver: ${homeserver}`);
  console.log(`User: ${userId}`);

  try {
    const client = sdk.createClient({ baseUrl: homeserver });
    const response = await client.loginWithPassword(userId, password);

    console.log('\n✓ Successfully authenticated!');
    console.log(`Access token: ${response.access_token.substring(0, 20)}...`);
    console.log(`Device ID: ${response.device_id}`);

    // Save session
    const storeDir = path.join(__dirname, '..', 'store');
    fs.mkdirSync(storeDir, { recursive: true });

    const sessionPath = path.join(storeDir, 'matrix-session.json');
    fs.writeFileSync(sessionPath, JSON.stringify({
      access_token: response.access_token,
      device_id: response.device_id,
      user_id: response.user_id,
    }, null, 2));

    console.log(`\nSession saved to: ${sessionPath}`);
    console.log('\nYou can now start NanoClaw with: npm run dev');

    // Test connection by fetching rooms
    const authedClient = sdk.createClient({
      baseUrl: homeserver,
      accessToken: response.access_token,
      userId: response.user_id,
    });

    await authedClient.startClient({ initialSyncLimit: 1 });

    // Wait for sync
    await new Promise<void>((resolve) => {
      authedClient.on(sdk.ClientEvent.Sync, (state) => {
        if (state === 'PREPARED') {
          resolve();
        }
      });
    });

    const rooms = authedClient.getRooms();
    console.log(`\nFound ${rooms.length} rooms:`);
    rooms.forEach((room) => {
      const name = room.name || 'Unnamed Room';
      const roomId = room.roomId;
      console.log(`  - ${name} (${roomId})`);
    });

    await authedClient.stopClient();
    process.exit(0);
  } catch (err: any) {
    console.error('\n✗ Authentication failed:');
    console.error(err.message);
    if (err.data) {
      console.error(JSON.stringify(err.data, null, 2));
    }
    process.exit(1);
  }
}

authenticate();
