import { installConsoleCli } from './install-cli.mjs';
import { withServicePortForward } from './port-forward.mjs';
import { defaultConsoleUrl, normalizeConsoleUrl } from './console-url.mjs';

export async function installConsoleCliFromCluster({
  consoleUrl = defaultConsoleUrl('edge', 'development'),
  installDirectory,
  updatePath = false
} = {}, {
  tunnel = withServicePortForward,
  install = installConsoleCli
} = {}) {
  return tunnel({
    namespace: 'opensphere-console',
    service: 'opensphere-console-ext',
    remotePort: 'https',
    label: 'Console artifact download',
    protocol: new URL(normalizeConsoleUrl(consoleUrl)).protocol.slice(0, -1)
  }, (consoleUrl) => install({
    consoleUrl,
    installDirectory,
    // The temporary service tunnel terminates at the bootstrap certificate.
    // Manifest and artifact bytes remain size/digest verified.
    insecureSkipTlsVerify: consoleUrl.startsWith('https:'),
    updatePath
  }));
}
