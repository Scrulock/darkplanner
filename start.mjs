
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', shell: true });
    child.on('exit', (code) => code === 0 ? resolve(code) : reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`)));
    child.on('error', reject);
  });
}
async function main() {
  const profileExists = existsSync('./backend/runtime/profiles/chatgpt');
  if (!profileExists) {
    console.log('🔐 Perfis não encontrados. Iniciando login persistente...');
    await run('npm', ['run', 'login']);
    console.log('✅ Login concluído.');
  } else {
    console.log('✅ Perfis encontrados. Pulando login.');
  }
  console.log('🚀 Subindo backend + frontend...');
  await run('npm', ['run', 'dev']);
}
main().catch((error) => {
  console.error('❌ Falha no start automático:', error.message || error);
  process.exit(1);
});
