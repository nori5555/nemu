import { ServerSourceBrowserScreen } from "@/screens/ServerSourceBrowserScreen";

/**
 * The server tab is browse-only: the server's library now lives in the
 * main Library tab, synced with the server, so this tab just opens the
 * source browser for the chosen server.
 */
export function ServerScreen({
  registryId,
  sourceId,
}: {
  registryId?: string;
  sourceId?: string;
}) {
  return (
    <ServerSourceBrowserScreen
      registryId={registryId}
      sourceId={sourceId}
      showHeader={false}
    />
  );
}
