/** What kind of file an extension stands for: one list for the whole of YDM
 * (the links offered on a page, the folders files are sorted into, the
 * programs left to the browser). */

export type Category = 'video' | 'audio' | 'images' | 'documents' | 'archives' | 'programs';

/** Extensions by kind, lowercase, without the dot. */
export const EXTENSION_GROUPS: Record<Category, readonly string[]> = {
  video: ['mp4', 'mkv', 'webm', 'avi', 'mov', 'm4v', 'wmv', 'flv', 'mpg', 'mpeg', 'ts', '3gp'],
  audio: ['mp3', 'flac', 'wav', 'ogg', 'opus', 'm4a', 'aac', 'wma', 'aiff'],
  images: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'tif', 'tiff', 'psd', 'raw', 'bmp', 'svg', 'heic', 'avif'],
  documents: ['pdf', 'epub', 'djvu', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'csv', 'txt', 'rtf', 'md'],
  archives: ['zip', '7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', 'iso', 'img', 'dmg'],
  programs: ['exe', 'msi', 'msix', 'apk', 'deb', 'rpm', 'appimage', 'pkg', 'jar'],
};

/** File types Windows, macOS or Linux run directly: the ones Safe Browsing
 * checks most closely. Wider than the "programs" folder (scripts, libraries,
 * shortcuts); archives and disk images are not among them. */
export const PROGRAM_EXTENSIONS = new Set([
  'exe', 'msi', 'msix', 'msixbundle', 'appx', 'appxbundle', 'com', 'scr', 'pif', 'cpl',
  'bat', 'cmd', 'ps1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'hta', 'lnk', 'reg',
  'jar', 'dll', 'sys', 'apk', 'pkg', 'app', 'deb', 'rpm', 'sh', 'run', 'appimage',
]);

/** The extension of a file name, lowercase, '' if none. */
export function extOfName(name: string): string {
  return /\.([a-z0-9]{1,10})$/i.exec(name.split(/[/\\]/).at(-1) ?? '')?.[1]?.toLowerCase() ?? '';
}

const BY_EXTENSION = new Map<string, Category>(
  (Object.entries(EXTENSION_GROUPS) as [Category, readonly string[]][]).flatMap(([cat, exts]) => exts.map((e) => [e, cat] as const)),
);

/** The kind of a file, from its name; null if it is none of them. */
export function categoryOf(name: string): Category | null {
  return BY_EXTENSION.get(extOfName(name)) ?? null;
}
