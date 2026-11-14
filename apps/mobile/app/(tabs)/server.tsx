import { SuwayomiServerTabHost } from "@/components/SuwayomiServerTabHost";
import { useMobileLanguageSettings } from "@/data/mobileHooks";
import { getMobileStrings } from "@/lib/mobileI18n";
import { ServerScreen } from "@/screens/ServerScreen";

/** Bottom bar: the Suwayomi server — Library and extension sources in one tab. */
export default function ServerTab() {
  const { appLanguage } = useMobileLanguageSettings();
  const strings = getMobileStrings(appLanguage);
  return (
    <SuwayomiServerTabHost title={strings.nav.server}>
      {(server) => (
        <ServerScreen registryId={server.registryId} sourceId={server.sourceId} />
      )}
    </SuwayomiServerTabHost>
  );
}
