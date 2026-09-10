const ENDPOINT = process.env.APPWRITE_ENDPOINT || process.env.VITE_APPWRITE_ENDPOINT || 'https://appwrite.redview.tech/v1';
const PROJECT_ID = process.env.APPWRITE_PROJECT_ID || process.env.VITE_APPWRITE_PROJECT_ID || 'redview-prod';
const DATABASE_ID = process.env.APPWRITE_DATABASE_ID || process.env.VITE_APPWRITE_DATABASE_ID || 'redview-db';
const API_KEY = process.env.APPWRITE_API_KEY || '';

const headers = {
  'Content-Type': 'application/json',
  'X-Appwrite-Project': PROJECT_ID,
  'X-Appwrite-Key': API_KEY,
};

async function api(path, method = 'GET', body = null) {
  const url = `${ENDPOINT}${path}`;
  const init = {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  };
  const res = await fetch(url, init);
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log('=== Step 1: Create Database ===');
  const dbCheck = await api(`/databases/${DATABASE_ID}`);
  if (!dbCheck.ok) {
    const dbCreate = await api('/databases', 'POST', {
      databaseId: DATABASE_ID,
      name: 'RedView Production Database',
    });
    console.log('Database create:', dbCreate.status, dbCreate.data?.name || dbCreate.data?.message);
  } else {
    console.log('Database redview-db already exists');
  }

  console.log('\n=== Step 2: Create Collections ===');
  const collections = [
    {
      id: 'projects',
      name: 'Projects',
      documentSecurity: true,
      permissions: [
        'read("users")',
        'create("users")',
        'update("users")',
        'delete("users")',
      ],
      attributes: [
        { type: 'string', key: 'name', size: 255, required: true },
        { type: 'string', key: 'user_id', size: 128, required: true },
        { type: 'string', key: 'folder_id', size: 128, required: false },
        { type: 'integer', key: 'size_bytes', required: false, default: 0, min: 0, max: 2147483647 },
        { type: 'string', key: 'privacy', size: 32, required: false, default: 'private' },
        { type: 'string', key: 'data', size: 1000000, required: false },
      ],
      indexes: [
        { key: 'idx_projects_user_id', type: 'key', attributes: ['user_id'] },
      ],
    },
    {
      id: 'project_folders',
      name: 'Project Folders',
      documentSecurity: true,
      permissions: [
        'read("users")',
        'create("users")',
        'update("users")',
        'delete("users")',
      ],
      attributes: [
        { type: 'string', key: 'name', size: 255, required: true },
        { type: 'string', key: 'user_id', size: 128, required: true },
        { type: 'string', key: 'parent_folder_id', size: 128, required: false },
        { type: 'string', key: 'privacy', size: 32, required: false, default: 'private' },
      ],
      indexes: [
        { key: 'idx_folders_user_id', type: 'key', attributes: ['user_id'] },
      ],
    },
    {
      id: 'customers',
      name: 'Stripe Customers',
      documentSecurity: false,
      permissions: ['read("users")'],
      attributes: [
        { type: 'string', key: 'user_id', size: 128, required: true },
        { type: 'string', key: 'stripe_customer_id', size: 128, required: true },
        { type: 'string', key: 'billing_email_mode', size: 32, required: false },
        { type: 'string', key: 'billing_email', size: 255, required: false },
      ],
      indexes: [
        { key: 'idx_customers_user_id', type: 'key', attributes: ['user_id'] },
        { key: 'idx_customers_stripe_id', type: 'key', attributes: ['stripe_customer_id'] },
      ],
    },
    {
      id: 'subscriptions',
      name: 'User Subscriptions',
      documentSecurity: false,
      permissions: ['read("users")'],
      attributes: [
        { type: 'string', key: 'user_id', size: 128, required: true },
        { type: 'string', key: 'status', size: 64, required: true },
        { type: 'string', key: 'price_id', size: 128, required: false },
        { type: 'string', key: 'current_period_start', size: 64, required: false },
        { type: 'string', key: 'current_period_end', size: 64, required: false },
        { type: 'boolean', key: 'cancel_at_period_end', required: false, default: false },
      ],
      indexes: [
        { key: 'idx_subs_user_id', type: 'key', attributes: ['user_id'] },
      ],
    },
  ];

  for (const col of collections) {
    console.log(`Checking collection ${col.id}...`);
    const check = await api(`/databases/${DATABASE_ID}/collections/${col.id}`);
    if (!check.ok) {
      const res = await api(`/databases/${DATABASE_ID}/collections`, 'POST', {
        collectionId: col.id,
        name: col.name,
        permissions: col.permissions,
        documentSecurity: col.documentSecurity,
      });
      console.log(`Created collection ${col.id}:`, res.status);
    } else {
      console.log(`Collection ${col.id} exists`);
    }

    // Add attributes
    for (const attr of col.attributes) {
      let attrPath = `/databases/${DATABASE_ID}/collections/${col.id}/attributes/${attr.type}`;
      const payload = {
        key: attr.key,
        required: attr.required,
      };
      if (attr.type === 'string') {
        payload.size = attr.size;
        if (attr.default !== undefined) payload.default = attr.default;
      } else if (attr.type === 'integer') {
        if (attr.min !== undefined) payload.min = attr.min;
        if (attr.max !== undefined) payload.max = attr.max;
        if (attr.default !== undefined) payload.default = attr.default;
      } else if (attr.type === 'boolean') {
        if (attr.default !== undefined) payload.default = attr.default;
      }

      const attrRes = await api(attrPath, 'POST', payload);
      if (attrRes.ok || attrRes.status === 409) {
        console.log(`  Attribute ${col.id}.${attr.key}: OK (${attrRes.status})`);
      } else {
        console.log(`  Attribute ${col.id}.${attr.key} error:`, attrRes.status, attrRes.data?.message);
      }
      await sleep(100);
    }

    // Wait for attributes to be in 'available' status before adding indexes
    console.log(`Waiting for attributes in ${col.id} to be processed...`);
    await sleep(1500);

    // Add indexes
    for (const idx of col.indexes) {
      const idxRes = await api(`/databases/${DATABASE_ID}/collections/${col.id}/indexes`, 'POST', {
        key: idx.key,
        type: idx.type,
        attributes: idx.attributes,
      });
      if (idxRes.ok || idxRes.status === 409) {
        console.log(`  Index ${col.id}.${idx.key}: OK (${idxRes.status})`);
      } else {
        console.log(`  Index ${col.id}.${idx.key} error:`, idxRes.status, idxRes.data?.message);
      }
      await sleep(100);
    }
  }

  console.log('\n=== Step 3: Create Storage Buckets ===');
  const buckets = [
    {
      id: 'project-thumbnails',
      name: 'Project Thumbnails',
      permissions: [
        'read("any")',
        'create("users")',
        'update("users")',
        'delete("users")',
      ],
      fileSecurity: false,
      maxFileSize: 10485760, // 10MB
      allowedFileExtensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'],
    },
    {
      id: 'itinerary-fit-files',
      name: 'Itinerary FIT Files',
      permissions: [
        'read("users")',
        'create("users")',
        'update("users")',
        'delete("users")',
      ],
      fileSecurity: true,
      maxFileSize: 30000000, // 30MB
      allowedFileExtensions: ['fit'],
    },
  ];

  for (const b of buckets) {
    console.log(`Checking bucket ${b.id}...`);
    const check = await api(`/storage/buckets/${b.id}`);
    if (!check.ok) {
      const bRes = await api('/storage/buckets', 'POST', {
        bucketId: b.id,
        name: b.name,
        permissions: b.permissions,
        fileSecurity: b.fileSecurity,
        maximumFileSize: b.maxFileSize,
        allowedFileExtensions: b.allowedFileExtensions,
      });
      console.log(`Created bucket ${b.id}:`, bRes.status, bRes.data?.name || bRes.data?.message);
    } else {
      console.log(`Bucket ${b.id} exists`);
    }
  }

  console.log('\n=== Setup Complete! ===');
}

main().catch(console.error);
