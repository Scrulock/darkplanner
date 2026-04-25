
import { AutomationBridge } from './playwright-automation-bridge.js';

async function main() {
  const bridge = new AutomationBridge();
  await bridge.init();
  await bridge.firstTimeLogin();
  await bridge.close();
  console.log('Login manual concluído e perfis persistentes preparados.');
}

main().catch((error) => {
  console.error('Falha no login manual:', error);
  process.exit(1);
});
