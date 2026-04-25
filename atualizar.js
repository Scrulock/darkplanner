/**
 * DARKPLANNER — Auto Update
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const PATCH_URL = 'https://raw.githubusercontent.com/Scrulock/darkplanner/main/patch.json';
const PROJECT_ROOT = __dirname;

console.log('\n🔄 DarkPlanner — Auto Update');
console.log('=' .repeat(50));

async function downloadPatch() {
  return new Promise((resolve, reject) => {
    https.get(PATCH_URL, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject('❌ patch.json inválido: ' + e.message);
        }
      });
    }).on('error', reject);
  });
}

async function applyPatch(patch) {
  let applied = 0;
  for (const file of patch.files) {
    const dest = path.join(PROJECT_ROOT, file.path);
    const dir = path.dirname(dest);
    try {
      if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
      if (fs.existsSync(dest)) { fs.copyFileSync(dest, dest + '.bak'); }
      fs.writeFileSync(dest, file.content, 'utf8');
      console.log('  ✅', file.path);
      applied++;
    } catch (e) {
      console.error('  ❌', file.path, '—', e.message);
    }
  }
  return applied;
}

function gitCommitAndPush(version) {
  try {
    console.log('\n📤 Fazendo commit e push...');
    execSync('git add .', { stdio: 'inherit' });
    execSync(`git commit -m "Update: ${version || 'patch from Claude'}"`, { stdio: 'inherit' });
    execSync('git push origin main', { stdio: 'inherit' });
    console.log('✅ Push feito!\n');
  } catch (e) {
    console.log('⚠️  Erro ao fazer push\n');
  }
}

(async () => {
  try {
    console.log('\n📥 Baixando patch...');
    const patch = await downloadPatch();
    console.log(`   Versão: ${patch.version || 'N/A'}`);
    console.log(`   Arquivos: ${patch.files.length}`);
    console.log('\n📝 Aplicando mudanças...');
    const applied = await applyPatch(patch);
    console.log(`\n✅ ${applied} arquivo(s) atualizado(s)`);
    gitCommitAndPush(patch.version);
  } catch (err) {
    console.error('\n❌ Erro:', err);
    process.exit(1);
  }
})();
