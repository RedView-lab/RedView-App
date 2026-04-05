const LIDAR_DIR = 'lidar-hd';

let dirHandle: FileSystemDirectoryHandle | null = null;

export async function getLidarDir(): Promise<FileSystemDirectoryHandle> {
  if (dirHandle) return dirHandle;
  const root = await navigator.storage.getDirectory();
  dirHandle = await root.getDirectoryHandle(LIDAR_DIR, { create: true });
  return dirHandle;
}
