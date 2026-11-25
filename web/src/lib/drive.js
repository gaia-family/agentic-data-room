import { GoogleAuth } from 'google-auth-library';

const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '{}');
const rootFolderId = process.env.DRIVE_ROOT_FOLDER_ID;

const DRIVE_ID = /^[A-Za-z0-9_-]+$/;
function assertDriveId(id) {
  if (!DRIVE_ID.test(String(id || ''))) throw new Error('Unknown file');
  return id;
}

const auth = new GoogleAuth({
  credentials,
  scopes: ['https://www.googleapis.com/auth/drive.readonly'],
});

function getMimeKind(mimeType, name) {
  if (mimeType === 'application/pdf') {
    if (/deck|pitch|presentation|slide/i.test(name)) return 'deck';
    return 'doc';
  }
  if (
    mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    mimeType === 'application/vnd.google-apps.spreadsheet'
  ) {
    return 'sheet';
  }
  return 'doc';
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '—';
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return parseFloat((bytes / Math.pow(1024, i)).toFixed(1)) + ' ' + sizes[i];
}

async function driveRequest(url) {
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  // Add shared-drive support params if not already present
  const separator = url.includes('?') ? '&' : '?';
  const fullUrl = url.includes('supportsAllDrives') ? url : `${url}${separator}supportsAllDrives=true&includeItemsFromAllDrives=true`;
  const res = await fetch(fullUrl, {
    headers: { Authorization: `Bearer ${token.token}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Drive API error ${res.status}: ${text}`);
  }
  return res.json();
}

/**
 * Fetches all pages for a Drive files.list query, returning the full files array.
 */
async function driveListAll(baseUrl) {
  let allFiles = [];
  let pageToken = null;
  do {
    const url = pageToken
      ? `${baseUrl}&pageToken=${encodeURIComponent(pageToken)}`
      : baseUrl;
    const data = await driveRequest(url);
    allFiles = allFiles.concat(data.files || []);
    pageToken = data.nextPageToken || null;
  } while (pageToken);
  return allFiles;
}

export async function listFolders() {
  const url = `https://www.googleapis.com/drive/v3/files?q='${rootFolderId}'+in+parents+and+mimeType='application/vnd.google-apps.folder'+and+trashed=false&fields=files(id,name)&orderBy=name&supportsAllDrives=true&includeItemsFromAllDrives=true`;
  return driveListAll(url);
}

/**
 * List immediate subfolders of any folder.
 */
export async function listSubfolders(folderId) {
  assertDriveId(folderId);
  const url = `https://www.googleapis.com/drive/v3/files?q='${folderId}'+in+parents+and+mimeType='application/vnd.google-apps.folder'+and+trashed=false&fields=files(id,name)&orderBy=name&supportsAllDrives=true&includeItemsFromAllDrives=true`;
  return driveListAll(url);
}

/**
 * List files (non-folders) directly inside a folder — no recursion.
 */
export async function listFiles(folderId) {
  assertDriveId(folderId);
  const url = `https://www.googleapis.com/drive/v3/files?q='${folderId}'+in+parents+and+mimeType!='application/vnd.google-apps.folder'+and+trashed=false&fields=files(id,name,mimeType,size,modifiedTime)&orderBy=name&supportsAllDrives=true&includeItemsFromAllDrives=true`;
  const raw = await driveListAll(url);
  return raw.map((f) => ({
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    size: formatBytes(parseInt(f.size || '0', 10)),
    modifiedTime: f.modifiedTime,
    kind: getMimeKind(f.mimeType, f.name),
  }));
}

/**
 * Recursively list all files under a folder, traversing every nested subfolder.
 * Each returned file includes a `pathSegments` array of subfolder names leading
 * to the file (empty for files at the root of folderId).
 */
export async function listFilesRecursive(folderId, pathSegments = []) {
  const [files, subfolders] = await Promise.all([
    listFiles(folderId),
    listSubfolders(folderId),
  ]);

  const filesWithPath = files.map((f) => ({ ...f, pathSegments }));

  const nested = await Promise.all(
    subfolders.map((sub) =>
      listFilesRecursive(sub.id, [...pathSegments, sub.name]).catch(() => [])
    )
  );

  return [...filesWithPath, ...nested.flat()];
}


/**
 * Walk parents up to the data room root and return the top-level folder id.
 * Returns null if the folder is not under the root.
 */
export async function getTopFolderId(folderId) {
  let current = assertDriveId(folderId);
  for (let hops = 0; hops < 20; hops++) {
    const meta = await driveRequest(`https://www.googleapis.com/drive/v3/files/${current}?fields=id,parents`);
    const parent = meta.parents?.[0];
    if (!parent) return null;
    if (parent === rootFolderId) return current;
    current = parent;
  }
  return null;
}

export async function getFileMeta(fileId) {
  assertDriveId(fileId);
  const url = `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,mimeType,size,parents`;
  return driveRequest(url);
}

export async function getFileStream(fileId, mimeType) {
  assertDriveId(fileId);
  const client = await auth.getClient();
  const token = await client.getAccessToken();

  let url;
  if (mimeType === 'application/vnd.google-apps.spreadsheet') {
    url = `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`;
  } else if (mimeType === 'application/vnd.google-apps.document') {
    url = `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=application/pdf`;
  } else {
    url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
  }

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token.token}` },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Drive API error ${res.status}: ${text}`);
  }

  return res;
}
