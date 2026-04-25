/**
 * GERADOR AUTOMÁTICO DE PATCH.JSON
 * Executado após cada teste bem-sucedido
 */

const fs = require('fs');
const path = require('path');

const projectRoot = __dirname;

function generatePatch() {
  const files = [
    'frontend/src/App.tsx',
    'backend/src/automation-bridge-server.ts',
    'backend/src/playwright-automation-bridge.ts',
    'backend/src/index.ts',
    'start.mjs',
    'atualizar.js',
    'package.json',
    '.gitignore'
  ];

  const patch = {
    version: `dp_v536_${new Date().toISOString().slice(0, 10)}`,
    timestamp: new Date().toISOString(),
    description: 'DarkPlanner V5.3.6 - Auto-generated after tests',
    gitHash: require('child_process').execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim(),
    files: {}
  };

  files.forEach(file => {
    const filepath = path.join(projectRoot, file);
    if (fs.existsSync(filepath)) {
      const content = fs.readFileSync(filepath, 'utf8');
      patch.files[file] = content;
    }
  });

  const jsonString = JSON.stringify(patch, null, 2);
  fs.writeFileSync(path.join(projectRoot, 'patch.json'), jsonString, 'utf8');

  console.log(`✅ patch.json gerado (${Object.keys(patch.files).length} arquivos)`);
}

generatePatch();
