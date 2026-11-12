import { File, Paths } from "expo-file-system";

// The default collection the Library opens on: one small file in the
// document directory, following the per-title reading-mode storage. Device-
// local — never synced, never sent to the server. The file holds the
// collection id as plain text; a missing file means All.

function defaultCollectionFile(): File {
  return new File(Paths.document, "nemu-library-default-collection-v1.json");
}

export async function readMobileLibraryDefaultCollectionText(): Promise<string | null> {
  try {
    const file = defaultCollectionFile();
    if (!file.exists) return null;
    return await file.text();
  } catch {
    return null;
  }
}

export async function writeMobileLibraryDefaultCollectionText(
  text: string | null,
): Promise<void> {
  try {
    const file = defaultCollectionFile();
    if (text === null) {
      if (file.exists) file.delete();
      return;
    }
    file.write(text);
  } catch {
    // Losing it only means the library opens on All.
  }
}
