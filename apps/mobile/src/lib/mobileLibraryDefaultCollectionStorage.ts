// Base (non-native) storage for the default collection: in memory only.
// Metro resolves `mobileLibraryDefaultCollectionStorage.native.ts` on iOS and
// Android; bun's test runner and Expo web resolve this file.

let text: string | null = null;

export async function readMobileLibraryDefaultCollectionText(): Promise<string | null> {
  return text;
}

export async function writeMobileLibraryDefaultCollectionText(
  next: string | null,
): Promise<void> {
  text = next;
}
