export const OPENSPHERE_ANSI_SHADOW = String.raw` ██████╗ ██████╗ ███████╗███╗   ██╗███████╗██████╗ ██╗  ██╗███████╗██████╗ ███████╗
██╔═══██╗██╔══██╗██╔════╝████╗  ██║██╔════╝██╔══██╗██║  ██║██╔════╝██╔══██╗██╔════╝
██║   ██║██████╔╝█████╗  ██╔██╗ ██║███████╗██████╔╝███████║█████╗  ██████╔╝█████╗
██║   ██║██╔═══╝ ██╔══╝  ██║╚██╗██║╚════██║██╔═══╝ ██╔══██║██╔══╝  ██╔══██╗██╔══╝
╚██████╔╝██║     ███████╗██║ ╚████║███████║██║     ██║  ██║███████╗██║  ██║███████╗
 ╚═════╝ ╚═╝     ╚══════╝╚═╝  ╚═══╝╚══════╝╚═╝     ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚══════╝`;

const INTERACTIVE_COMMANDS = new Set([
  'bootstrap',
  'doctor',
  'install-cli',
  'preflight',
  'reset-initial-admin',
  'uninstall',
  'upgrade',
  'verify'
]);

export function shouldPrintOpenSphereBanner({
  command,
  stream = process.stdout,
  environment = process.env
}) {
  return Boolean(stream?.isTTY)
    && environment.OPENSPHERE_NO_BANNER !== '1'
    && INTERACTIVE_COMMANDS.has(command);
}

export function printOpenSphereBanner(options) {
  const stream = options?.stream ?? process.stdout;
  if (!shouldPrintOpenSphereBanner({ ...options, stream })) return false;
  stream.write(`${OPENSPHERE_ANSI_SHADOW}\n\n`);
  return true;
}
