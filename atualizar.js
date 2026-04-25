#!/usr/bin/env node
/**
 * DarkPlanner — Auto Update v3.0
 * Baixa patch publicamente do GitHub (sem token necessário)
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO = 'Scrulock/darkplanner';
const BRANCH = 'main';

// ===== CORES =====
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

function log(msg, type = 'info') {
  const symbols = { info: '📥', success: '✅', error: '❌', warn: '⚠️ ' };
  const colorMap = { info: 'cyan', success: 'green', error: 'red', warn: 'yellow' };
  console.log(`${colors[colorMap[type]] || colors.reset}${symbols[type] || '•'} ${msg}${colors.reset}`);
}

// ===== BAIXAR PATCH =====
function downloadPatch() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'raw.githubusercontent.com',
      path: `/${REPO}/${BRANCH}/patch.json`,
      method: 'GET',
      headers: { 'User-Agent': 'DarkPlanner-Updater' }
    };

    https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          data = data.replace(/^\uFEFF/, '').trim();
          if (!data.startsWith('{')) throw new Error('Response não é JSON');
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`JSON inválido: ${e.message}`));
        }
      });
    }).on('error', reject).end();
  });
}

// ===== APLICAR PATCH =====
function applyPatch(patch) {
  log('Aplicando mudanças...', 'info');
  
  if (!patch.files || typeof patch.files !== 'object') {
    throw new Error(`patch.files inválido`);
  }
  
  const entries = Object.entries(patch.files);
  if (entries.length === 0) throw new Error('Nenhum arquivo no patch');

  let applied = 0;
  for (const [filepath, content] of entries) {
    try {
      const dir = path.dirname(filepath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filepath, content, 'utf8');
      log(`${filepath}`, 'success');
      applied++;
    } catch (e) {
      log(`${filepath}: ${e.message}`, 'error');
    }
  }

  log(`${applied}/${entries.length} arquivo(s) aplicado(s)`, 'success');
  return true;
}

// ===== MAIN =====
async function main() {
  console.log('\n🔄 DarkPlanner — Auto Update');
  console.log('==================================================');
  try {
    log('Baixando patch...', 'info');
    const patch = await downloadPatch();
    log(`Versão: ${patch.version}`, 'info');
    log(`Arquivos: ${Object.keys(patch.files).length}`, 'info');
    
    applyPatch(patch);
    
    console.log('\n' + '='.repeat(50));
    log('Atualização bem-sucedida!', 'success');
    log('Rode agora: npm run dev', 'info');
    console.log('='.repeat(50) + '\n');
  } catch (e) {
    log(`Erro: ${e.message}`, 'error');
    process.exit(1);
  }
}

main();
