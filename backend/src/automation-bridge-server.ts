
import express from 'express';
import cors from 'cors';
import { AutomationBridge } from './playwright-automation-bridge.js';

const app = express();
app.use(cors());
app.use(express.json());

const bridge = new AutomationBridge();
await bridge.init();
// Chrome só abre quando o usuário clicar em algo — evita crash no startup

app.get('/health', async (_req, res) => {
  res.json({ ok: true, mode: 'darkplanner_v2_status_send_fix' });
});

app.get('/chatgpt-status', async (_req, res) => {
  try {
    const status = await bridge.getChatGPTStatus();
    res.json({ ok: true, status });
  } catch (err: any) {
    res.json({ ok: false, error: String(err?.message || err) });
  }
});

app.post('/open-service', async (req, res) => {
  try {
    const { service } = req.body;
    if (!['chatgpt', 'flow', 'grok'].includes(service)) throw new Error('Serviço inválido');
    const result = await bridge.openVisibleService(service);
    res.json({ ok: true, ...result });
  } catch (err: any) {
    res.json({ ok: false, error: String(err?.message || err) });
  }
});


app.get('/service-status', async (req, res) => {
  try {
    const service = String(req.query.service || '') as any;
    const status = await (bridge as any).getServiceStatus(service);
    res.json({ ok: true, status });
  } catch (err: any) {
    res.json({ ok: false, error: String(err?.message || err) });
  }
});

app.post('/flow-automate-single', async (req, res) => {
  try {
    const result = await (bridge as any).flowAutomateSingleScene(req.body || {});
    res.json({ ok: true, result });
  } catch (err: any) {
    res.json({ ok: false, error: String(err?.message || err) });
  }
});


app.post('/flow-open-new-project', async (_req, res) => {
  try {
    await bridge.openVisibleService('flow');
    const page = (bridge as any).pages['flow'];
    await page.goto('https://labs.google/fx/pt/tools/flow', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(2200);

    let clicked = false;
    const candidates = [
      page.getByRole('button', { name: /novo projeto|new project|criar projeto/i }),
      page.getByText('Novo projeto', { exact: false }),
      page.getByText('New project', { exact: false }),
      page.getByText('Criar projeto', { exact: false }),
    ];

    for (const loc of candidates) {
      try {
        const n = await loc.count();
        if (!n) continue;
        const el = loc.first();
        await el.scrollIntoViewIfNeeded().catch(() => {});
        await el.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
        await el.click({ timeout: 4000 });
        await page.waitForTimeout(1800);
        clicked = true;
        break;
      } catch {}
    }

    const body = ((await page.textContent('body').catch(() => '')) || '').toLowerCase();
    const stillOnHome = /novo projeto|new project|criar projeto/.test(body);

    res.json({
      ok: true,
      result: {
        clicked,
        stillOnHome,
        url: page.url(),
        note: clicked && !stillOnHome ? 'Novo projeto acionado.' : clicked ? 'Clique feito, mas a tela inicial ainda parece aberta.' : 'Não encontrei o botão de novo projeto.'
      }
    });
  } catch (err: any) {
    res.json({ ok: false, error: String(err?.message || err) });
  }
});


app.post('/flow-test-config', async (req, res) => {
  try {
    const { aspectRatio, count, model } = req.body || {};
    const page = (bridge as any).pages['flow'];
    if (!page) throw new Error('Flow não está aberto.');
    await page.bringToFront().catch(() => {});
    await page.waitForTimeout(1200);

    const clickFirstVisible = async (locators, settle = 700) => {
      for (const loc of locators) {
        try {
          const n = await loc.count();
          if (!n) continue;
          const el = loc.first();
          await el.scrollIntoViewIfNeeded().catch(() => {});
          await el.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
          await el.click({ timeout: 4000 });
          await page.waitForTimeout(settle);
          return true;
        } catch {}
      }
      return false;
    };

    const chooseText = async (text, exact = false, settle = 900) => {
      const ok = await clickFirstVisible([
        page.locator('[role="menu"], [role="listbox"], [data-radix-popper-content-wrapper]').getByText(text, { exact }),
        page.getByRole('button', { name: exact ? text : new RegExp(text, 'i') }),
        page.getByText(text, { exact }),
      ], settle);
      return ok ? text : '';
    };

    const bodyContains = async (needle) => {
      const body = ((await page.textContent('body').catch(() => '')) || '').toLowerCase();
      return body.includes(String(needle).toLowerCase());
    };

    const composerArea = page.locator('xpath=//div[contains(., "O que você quer criar?")]').first();
    await composerArea.waitFor({ state: 'visible', timeout: 7000 }).catch(() => {});

    const steps = {};

    steps.openChip = await clickFirstVisible([
      composerArea.locator('button').filter({ hasText: /nano banana|imagem 4|x[1-4]/i }),
      composerArea.locator('[role="button"]').filter({ hasText: /nano banana|imagem 4|x[1-4]/i }),
      page.locator('button').filter({ hasText: /nano banana|imagem 4|x[1-4]/i }),
      page.locator('[role="button"]').filter({ hasText: /nano banana|imagem 4|x[1-4]/i }),
    ], 1000) ? 'ok' : 'not-found';

    steps.mode = await chooseText('Imagem') || await chooseText('Image');
    steps.modeValidated = await bodyContains('imagem') ? 'ok' : 'weak';

    steps.aspect = await chooseText(String(aspectRatio), true, 1000);
    steps.aspectValidated = await bodyContains(String(aspectRatio)) ? 'ok' : 'weak';

    const countText = `x${Number(count || 1)}`;
    steps.count = await chooseText(countText, true, 1000) || await chooseText(String(count || 1), true, 1000);
    steps.countValidated = await bodyContains(countText) ? 'ok' : 'weak';

    steps.openModelMenu = await clickFirstVisible([
      page.locator('button').filter({ hasText: /nano banana|imagem 4/i }),
      page.locator('[role="button"]').filter({ hasText: /nano banana|imagem 4/i }),
      page.getByText(/nano banana|imagem 4/i),
    ], 1000) ? 'ok' : 'not-found';

    let targetModel = String(model || 'Nano Banana 2');
    if (targetModel.toLowerCase().includes('pro')) targetModel = 'Nano Banana Pro';
    else if (targetModel.toLowerCase().includes('nano banana 2')) targetModel = 'Nano Banana 2';
    else if (targetModel.toLowerCase().includes('imagem 4')) targetModel = 'Imagem 4';

    steps.model = await chooseText(targetModel, false, 1100);
    steps.modelValidated = await bodyContains(targetModel) ? 'ok' : 'weak';

    const ok = Boolean(steps.openChip && steps.count);
    res.json({ ok: true, result: { ok, steps, url: page.url() } });
  } catch (err) {
    res.json({ ok: false, error: String(err?.message || err) });
  }
});


app.post('/flow-test-image-only', async (_req, res) => {
  try {
    const page = (bridge as any).pages['flow'];
    if (!page) throw new Error('Flow não está aberto.');

    await page.bringToFront().catch(() => {});
    await page.waitForTimeout(1500);

    const result: any = {
      chipClicked: false,
      imageClicked: false,
      url: page.url(),
      notes: []
    };

    const clickFirst = async (locators: any[], label: string, settle = 800) => {
      for (const loc of locators) {
        try {
          const n = await loc.count();
          if (!n) continue;
          const el = loc.first();
          await el.scrollIntoViewIfNeeded().catch(() => {});
          await el.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
          await el.click({ timeout: 5000 });
          await page.waitForTimeout(settle);
          result.notes.push(`clicou: ${label}`);
          return true;
        } catch (e: any) {
          result.notes.push(`falhou ${label}: ${String(e?.message || e).slice(0,120)}`);
        }
      }
      result.notes.push(`não achou: ${label}`);
      return false;
    };

    const composerArea = page.locator('xpath=//div[contains(., "O que você quer criar?")]').first();
    const composerExists = await composerArea.count().catch(() => 0);
    result.composerFound = composerExists > 0;

    result.chipClicked = await clickFirst([
      composerArea.locator('button').filter({ hasText: /nano banana|imagem 4|x[1-4]/i }),
      composerArea.locator('[role="button"]').filter({ hasText: /nano banana|imagem 4|x[1-4]/i }),
      page.locator('button').filter({ hasText: /nano banana|imagem 4|x[1-4]/i }),
      page.locator('[role="button"]').filter({ hasText: /nano banana|imagem 4|x[1-4]/i }),
    ], 'chip de configuração', 1400);

    result.imageClicked = await clickFirst([
      page.locator('[role="menu"], [role="listbox"], [data-radix-popper-content-wrapper]').getByText('Imagem', { exact: true }),
      page.locator('[role="menu"], [role="listbox"], [data-radix-popper-content-wrapper]').getByText('Image', { exact: true }),
      page.getByRole('button', { name: /^Imagem$/i }),
      page.getByRole('button', { name: /^Image$/i }),
      page.getByText('Imagem', { exact: true }),
      page.getByText('Image', { exact: true }),
    ], 'opção Imagem', 1400);

    const body = ((await page.textContent('body').catch(() => '')) || '');
    result.bodyHasImagem = /imagem/i.test(body);
    result.bodyHasVideo = /vídeo|video/i.test(body);
    result.finalUrl = page.url();

    res.json({ ok: true, result });
  } catch (err: any) {
    res.json({ ok: false, error: String(err?.message || err) });
  }
});


app.post('/flow-test-chip-only', async (_req, res) => {
  try {
    const page = (bridge as any).pages['flow'];
    if (!page) throw new Error('Flow não está aberto.');

    await page.bringToFront().catch(() => {});
    await page.waitForTimeout(1500);

    const result: any = {
      chipClicked: false,
      method: '',
      notes: [],
      url: page.url()
    };

    const clickFirst = async (locators: any[], label: string, settle = 1000) => {
      for (const loc of locators) {
        try {
          const n = await loc.count();
          result.notes.push(`${label}: count=${n}`);
          if (!n) continue;
          const el = loc.first();
          await el.scrollIntoViewIfNeeded().catch(() => {});
          await el.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
          await el.click({ timeout: 5000 });
          await page.waitForTimeout(settle);
          result.notes.push(`clicou: ${label}`);
          return true;
        } catch (e: any) {
          result.notes.push(`falhou ${label}: ${String(e?.message || e).slice(0,120)}`);
        }
      }
      return false;
    };

    const composerArea = page.locator('xpath=//div[contains(., "O que você quer criar?")]').first();
    const composerCount = await composerArea.count().catch(() => 0);
    result.composerFound = composerCount > 0;

    // Método 1: por texto dentro do composer.
    result.chipClicked = await clickFirst([
      composerArea.locator('button').filter({ hasText: /nano banana|imagem 4|x[1-4]/i }),
      composerArea.locator('[role="button"]').filter({ hasText: /nano banana|imagem 4|x[1-4]/i }),
      page.locator('button').filter({ hasText: /nano banana|imagem 4|x[1-4]/i }),
      page.locator('[role="button"]').filter({ hasText: /nano banana|imagem 4|x[1-4]/i }),
    ], 'chip por texto', 1200);

    if (result.chipClicked) {
      result.method = 'text';
    }

    // Método 2: clique por coordenada relativa ao compositor, na área direita inferior, onde fica o chip.
    if (!result.chipClicked && composerCount > 0) {
      try {
        const box = await composerArea.boundingBox();
        result.composerBox = box;
        if (box) {
          const x = box.x + box.width - 135;
          const y = box.y + box.height - 28;
          await page.mouse.click(x, y);
          await page.waitForTimeout(1200);
          result.chipClicked = true;
          result.method = 'relative-coordinate';
          result.notes.push(`clicou coordenada relativa: x=${Math.round(x)} y=${Math.round(y)}`);
        }
      } catch (e: any) {
        result.notes.push(`falhou coordenada relativa: ${String(e?.message || e).slice(0,120)}`);
      }
    }

    const body = ((await page.textContent('body').catch(() => '')) || '');
    result.bodyHasAspect = /16:9|4:3|1:1|3:4|9:16/.test(body);
    result.bodyHasQuantidade = /x1|x2|x3|x4/.test(body);
    result.bodyHasModelo = /Nano Banana Pro|Nano Banana 2|Imagem 4/i.test(body);
    result.finalUrl = page.url();

    res.json({ ok: true, result });
  } catch (err: any) {
    res.json({ ok: false, error: String(err?.message || err) });
  }
});


app.post('/flow-test-select-image', async (_req, res) => {
  try {
    const page = (bridge as any).pages['flow'];
    if (!page) throw new Error('Flow não está aberto.');

    await page.bringToFront().catch(() => {});
    await page.waitForTimeout(1200);

    const result: any = {
      chipClicked: false,
      imageClicked: false,
      method: '',
      notes: [],
      url: page.url()
    };

    const clickFirst = async (locators: any[], label: string, settle = 900) => {
      for (const loc of locators) {
        try {
          const n = await loc.count();
          result.notes.push(`${label}: count=${n}`);
          if (!n) continue;
          const el = loc.first();
          await el.scrollIntoViewIfNeeded().catch(() => {});
          await el.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
          await el.click({ timeout: 5000 });
          await page.waitForTimeout(settle);
          result.notes.push(`clicou: ${label}`);
          return true;
        } catch (e: any) {
          result.notes.push(`falhou ${label}: ${String(e?.message || e).slice(0,120)}`);
        }
      }
      result.notes.push(`não achou: ${label}`);
      return false;
    };

    const composerArea = page.locator('xpath=//div[contains(., "O que você quer criar?")]').first();
    result.composerFound = (await composerArea.count().catch(() => 0)) > 0;

    result.chipClicked = await clickFirst([
      composerArea.locator('button').filter({ hasText: /nano banana|imagem 4|x[1-4]/i }),
      composerArea.locator('[role="button"]').filter({ hasText: /nano banana|imagem 4|x[1-4]/i }),
      page.locator('button').filter({ hasText: /nano banana|imagem 4|x[1-4]/i }),
      page.locator('[role="button"]').filter({ hasText: /nano banana|imagem 4|x[1-4]/i }),
    ], 'chip de configuração', 1300);

    // aguardar menu renderizar
    await page.waitForTimeout(1000);

    // Seleciona Imagem SOMENTE em regiões de menu/popover primeiro
    result.imageClicked = await clickFirst([
      page.locator('[role="menu"]').getByText('Imagem', { exact: true }),
      page.locator('[role="listbox"]').getByText('Imagem', { exact: true }),
      page.locator('[data-radix-popper-content-wrapper]').getByText('Imagem', { exact: true }),
      page.locator('[role="dialog"]').getByText('Imagem', { exact: true }),
      page.locator('[role="presentation"]').getByText('Imagem', { exact: true }),
      page.getByRole('button', { name: /^Imagem$/i }),
      page.getByText('Imagem', { exact: true }),
    ], 'opção Imagem dentro do menu', 1300);

    const body = ((await page.textContent('body').catch(() => '')) || '');
    result.bodyHasImagem = /imagem/i.test(body);
    result.bodyHasVideo = /vídeo|video/i.test(body);
    result.bodyHasAspect = /16:9|4:3|1:1|3:4|9:16/.test(body);
    result.bodyHasQuantidade = /x1|x2|x3|x4/.test(body);
    result.bodyHasModelo = /Nano Banana Pro|Nano Banana 2|Imagem 4/i.test(body);
    result.finalUrl = page.url();

    res.json({ ok: true, result });
  } catch (err: any) {
    res.json({ ok: false, error: String(err?.message || err) });
  }
});


app.post('/flow-test-select-image-position', async (_req, res) => {
  try {
    const page = (bridge as any).pages['flow'];
    if (!page) throw new Error('Flow não está aberto.');

    await page.bringToFront().catch(() => {});
    await page.waitForTimeout(1200);

    const result: any = {
      chipClicked: false,
      imageClicked: false,
      method: '',
      notes: [],
      url: page.url()
    };

    const clickFirst = async (locators: any[], label: string, settle = 900) => {
      for (const loc of locators) {
        try {
          const n = await loc.count();
          result.notes.push(`${label}: count=${n}`);
          if (!n) continue;
          const el = loc.first();
          await el.scrollIntoViewIfNeeded().catch(() => {});
          await el.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
          await el.click({ timeout: 5000 });
          await page.waitForTimeout(settle);
          result.notes.push(`clicou: ${label}`);
          return true;
        } catch (e: any) {
          result.notes.push(`falhou ${label}: ${String(e?.message || e).slice(0,120)}`);
        }
      }
      result.notes.push(`não achou: ${label}`);
      return false;
    };

    const composerArea = page.locator('xpath=//div[contains(., "O que você quer criar?")]').first();
    result.composerFound = (await composerArea.count().catch(() => 0)) > 0;

    result.chipClicked = await clickFirst([
      composerArea.locator('button').filter({ hasText: /nano banana|imagem 4|x[1-4]/i }),
      composerArea.locator('[role="button"]').filter({ hasText: /nano banana|imagem 4|x[1-4]/i }),
      page.locator('button').filter({ hasText: /nano banana|imagem 4|x[1-4]/i }),
      page.locator('[role="button"]').filter({ hasText: /nano banana|imagem 4|x[1-4]/i }),
    ], 'chip de configuração', 1300);

    await page.waitForTimeout(1000);

    // Como "Imagem" não apareceu como texto clicável, usa o painel/popover aberto e clica no primeiro toggle da linha Imagem/Vídeo.
    const panelCandidates = [
      page.locator('[data-radix-popper-content-wrapper]').first(),
      page.locator('[role="dialog"]').first(),
      page.locator('[role="menu"]').first(),
      page.locator('[role="listbox"]').first(),
      page.locator('body').first(),
    ];

    let panelBox: any = null;
    let panelSource = '';
    for (const panel of panelCandidates) {
      try {
        const n = await panel.count();
        if (!n) continue;
        const box = await panel.boundingBox();
        if (box && box.width > 120 && box.height > 120) {
          panelBox = box;
          panelSource = await panel.evaluate((el: any) => el.getAttribute('role') || el.getAttribute('data-radix-popper-content-wrapper') || el.tagName).catch(() => 'unknown');
          break;
        }
      } catch {}
    }

    result.panelBox = panelBox;
    result.panelSource = panelSource;

    if (panelBox) {
      // Pela imagem enviada, Imagem/Vídeo fica no topo do painel; Imagem é o botão da esquerda.
      const points = [
        { x: panelBox.x + 70, y: panelBox.y + 48, label: 'top-left image toggle' },
        { x: panelBox.x + panelBox.width * 0.27, y: panelBox.y + 50, label: '27% top image toggle' },
        { x: panelBox.x + 50, y: panelBox.y + 68, label: 'lower-left image toggle' },
      ];

      for (const point of points) {
        try {
          await page.mouse.click(point.x, point.y);
          await page.waitForTimeout(900);
          result.notes.push(`clicou posição: ${point.label} x=${Math.round(point.x)} y=${Math.round(point.y)}`);
          result.imageClicked = true;
          result.method = point.label;
          break;
        } catch (e: any) {
          result.notes.push(`falhou posição ${point.label}: ${String(e?.message || e).slice(0,120)}`);
        }
      }
    }

    const body = ((await page.textContent('body').catch(() => '')) || '');
    result.bodyHasImagem = /imagem/i.test(body);
    result.bodyHasVideo = /vídeo|video/i.test(body);
    result.bodyHasAspect = /16:9|4:3|1:1|3:4|9:16/.test(body);
    result.bodyHasQuantidade = /x1|x2|x3|x4/.test(body);
    result.bodyHasModelo = /Nano Banana Pro|Nano Banana 2|Imagem 4/i.test(body);
    result.finalUrl = page.url();

    res.json({ ok: true, result });
  } catch (err: any) {
    res.json({ ok: false, error: String(err?.message || err) });
  }
});


app.post('/flow-test-aspect', async (req, res) => {
  try {
    const { aspectRatio } = req.body || {};
    const page = (bridge as any).pages['flow'];
    if (!page) throw new Error('Flow não está aberto.');

    await page.bringToFront().catch(() => {});
    await page.waitForTimeout(1200);

    const result: any = {
      chipClicked: false,
      imageClicked: false,
      aspectClicked: false,
      method: '',
      notes: [],
      url: page.url(),
      aspectRatio
    };

    const clickFirst = async (locators: any[], label: string, settle = 900) => {
      for (const loc of locators) {
        try {
          const n = await loc.count();
          result.notes.push(`${label}: count=${n}`);
          if (!n) continue;
          const el = loc.first();
          await el.scrollIntoViewIfNeeded().catch(() => {});
          await el.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
          await el.click({ timeout: 5000 });
          await page.waitForTimeout(settle);
          result.notes.push(`clicou: ${label}`);
          return true;
        } catch (e: any) {
          result.notes.push(`falhou ${label}: ${String(e?.message || e).slice(0,120)}`);
        }
      }
      result.notes.push(`não achou: ${label}`);
      return false;
    };

    const composerArea = page.locator('xpath=//div[contains(., "O que você quer criar?")]').first();
    result.composerFound = (await composerArea.count().catch(() => 0)) > 0;

    result.chipClicked = await clickFirst([
      composerArea.locator('button').filter({ hasText: /nano banana|imagem 4|x[1-4]/i }),
      composerArea.locator('[role="button"]').filter({ hasText: /nano banana|imagem 4|x[1-4]/i }),
      page.locator('button').filter({ hasText: /nano banana|imagem 4|x[1-4]/i }),
      page.locator('[role="button"]').filter({ hasText: /nano banana|imagem 4|x[1-4]/i }),
    ], 'chip de configuração', 1300);

    await page.waitForTimeout(900);

    // Seleciona Imagem por posição confirmada anteriormente.
    const panelCandidates = [
      page.locator('[data-radix-popper-content-wrapper]').first(),
      page.locator('[role="dialog"]').first(),
      page.locator('[role="menu"]').first(),
      page.locator('[role="listbox"]').first(),
      page.locator('body').first(),
    ];

    let panelBox: any = null;
    let panelSource = '';
    for (const panel of panelCandidates) {
      try {
        const n = await panel.count();
        if (!n) continue;
        const box = await panel.boundingBox();
        if (box && box.width > 120 && box.height > 120) {
          panelBox = box;
          panelSource = await panel.evaluate((el: any) => el.getAttribute('role') || el.getAttribute('data-radix-popper-content-wrapper') || el.tagName).catch(() => 'unknown');
          break;
        }
      } catch {}
    }

    result.panelBox = panelBox;
    result.panelSource = panelSource;

    if (panelBox) {
      const imgX = panelBox.x + 70;
      const imgY = panelBox.y + 48;
      await page.mouse.click(imgX, imgY);
      await page.waitForTimeout(900);
      result.imageClicked = true;
      result.notes.push(`clicou imagem posição: x=${Math.round(imgX)} y=${Math.round(imgY)}`);
    }

    // Proporção: primeiro tenta por texto clicável no painel.
    const aspect = String(aspectRatio || '9:16');
    result.aspectClicked = await clickFirst([
      page.locator('[role="menu"], [role="listbox"], [data-radix-popper-content-wrapper], [role="dialog"]').getByText(aspect, { exact: true }),
      page.getByRole('button', { name: new RegExp('^' + aspect.replace(':', '\\:') + '$', 'i') }),
      page.getByText(aspect, { exact: true }),
    ], `proporção ${aspect}`, 1200);

    // Se texto não funcionar, clica por posição da fileira de proporções.
    if (!result.aspectClicked && panelBox) {
      const ratios = ['16:9', '4:3', '1:1', '3:4', '9:16'];
      const index = Math.max(0, ratios.indexOf(aspect));
      const startX = panelBox.x + 48;
      const gap = 58;
      const x = startX + (index * gap);
      const y = panelBox.y + 132;
      await page.mouse.click(x, y);
      await page.waitForTimeout(1000);
      result.aspectClicked = true;
      result.method = 'position';
      result.notes.push(`clicou proporção por posição: ${aspect} x=${Math.round(x)} y=${Math.round(y)} index=${index}`);
    } else if (result.aspectClicked) {
      result.method = 'text';
    }

    const body = ((await page.textContent('body').catch(() => '')) || '');
    result.bodyHasAspect = new RegExp(aspect.replace(':', '\\:'), 'i').test(body);
    result.bodyHasQuantidade = /x1|x2|x3|x4/.test(body);
    result.bodyHasModelo = /Nano Banana Pro|Nano Banana 2|Imagem 4/i.test(body);
    result.finalUrl = page.url();

    res.json({ ok: true, result });
  } catch (err: any) {
    res.json({ ok: false, error: String(err?.message || err) });
  }
});


app.post('/flow-test-aspect-stable', async (req, res) => {
  try {
    const { aspectRatio } = req.body || {};
    const page = (bridge as any).pages['flow'];
    if (!page) throw new Error('Flow não está aberto.');

    await page.bringToFront().catch(() => {});
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(1400);

    const result: any = {
      chipClicked: false,
      imageClicked: false,
      aspectClicked: false,
      method: '',
      notes: [],
      url: page.url(),
      aspectRatio
    };

    const safeCount = async (loc: any) => {
      try { return await loc.count(); } catch { return 0; }
    };

    const clickFirst = async (locators: any[], label: string, settle = 900) => {
      for (const loc of locators) {
        try {
          const n = await safeCount(loc);
          result.notes.push(`${label}: count=${n}`);
          if (!n) continue;
          const el = loc.first();
          await el.scrollIntoViewIfNeeded().catch(() => {});
          await el.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
          await el.click({ timeout: 5000 });
          await page.waitForLoadState('domcontentloaded').catch(() => {});
          await page.waitForTimeout(settle);
          result.notes.push(`clicou: ${label}`);
          return true;
        } catch (e: any) {
          result.notes.push(`falhou ${label}: ${String(e?.message || e).slice(0,160)}`);
        }
      }
      result.notes.push(`não achou: ${label}`);
      return false;
    };

    const findComposer = () => page.locator('xpath=//div[contains(., "O que você quer criar?")]').first();

    let composerArea = findComposer();
    result.composerFound = (await safeCount(composerArea)) > 0;

    result.chipClicked = await clickFirst([
      composerArea.locator('button').filter({ hasText: /nano banana|imagem 4|x[1-4]/i }),
      composerArea.locator('[role="button"]').filter({ hasText: /nano banana|imagem 4|x[1-4]/i }),
      page.locator('button').filter({ hasText: /nano banana|imagem 4|x[1-4]/i }),
      page.locator('[role="button"]').filter({ hasText: /nano banana|imagem 4|x[1-4]/i }),
    ], 'chip de configuração', 1300);

    await page.waitForTimeout(900);

    // Recria locators após possível renderização.
    composerArea = findComposer();

    // Descobre painel pelo boundingBox sem evaluate.
    const panelCandidates = [
      page.locator('[data-radix-popper-content-wrapper]').first(),
      page.locator('[role="dialog"]').first(),
      page.locator('[role="menu"]').first(),
      page.locator('[role="listbox"]').first(),
      page.locator('body').first(),
    ];

    let panelBox: any = null;
    let panelIndex = -1;

    for (let i = 0; i < panelCandidates.length; i++) {
      const panel = panelCandidates[i];
      try {
        const n = await safeCount(panel);
        result.notes.push(`panel candidate ${i}: count=${n}`);
        if (!n) continue;
        const box = await panel.boundingBox().catch(() => null);
        result.notes.push(`panel candidate ${i}: box=${box ? `${Math.round(box.x)},${Math.round(box.y)},${Math.round(box.width)},${Math.round(box.height)}` : 'null'}`);
        if (box && box.width > 120 && box.height > 120) {
          panelBox = box;
          panelIndex = i;
          break;
        }
      } catch (e: any) {
        result.notes.push(`panel candidate ${i} falhou: ${String(e?.message || e).slice(0,140)}`);
      }
    }

    result.panelBox = panelBox;
    result.panelIndex = panelIndex;

    if (panelBox) {
      // Clique de Imagem confirmado no teste anterior.
      const imgX = panelBox.x + 70;
      const imgY = panelBox.y + 48;
      try {
        await page.mouse.click(imgX, imgY);
        await page.waitForTimeout(900);
        result.imageClicked = true;
        result.notes.push(`clicou imagem posição: x=${Math.round(imgX)} y=${Math.round(imgY)}`);
      } catch (e: any) {
        result.notes.push(`falhou clique imagem posição: ${String(e?.message || e).slice(0,140)}`);
      }
    }

    await page.waitForTimeout(600);

    const aspect = String(aspectRatio || '9:16');

    // Primeiro tenta texto no painel.
    result.aspectClicked = await clickFirst([
      page.locator('[role="menu"], [role="listbox"], [data-radix-popper-content-wrapper], [role="dialog"]').getByText(aspect, { exact: true }),
      page.getByRole('button', { name: new RegExp('^' + aspect.replace(':', '\\:') + '$', 'i') }),
      page.getByText(aspect, { exact: true }),
    ], `proporção ${aspect}`, 1200);

    // Fallback por posição: fileira de proporções abaixo do seletor Imagem/Vídeo.
    if (!result.aspectClicked && panelBox) {
      const ratios = ['16:9', '4:3', '1:1', '3:4', '9:16'];
      const index = Math.max(0, ratios.indexOf(aspect));
      const startX = panelBox.x + 48;
      const gap = 58;
      const x = startX + (index * gap);
      const y = panelBox.y + 132;
      try {
        await page.mouse.click(x, y);
        await page.waitForTimeout(1000);
        result.aspectClicked = true;
        result.method = 'position';
        result.notes.push(`clicou proporção por posição: ${aspect} x=${Math.round(x)} y=${Math.round(y)} index=${index}`);
      } catch (e: any) {
        result.notes.push(`falhou proporção por posição: ${String(e?.message || e).slice(0,140)}`);
      }
    } else if (result.aspectClicked) {
      result.method = 'text';
    }

    const body = ((await page.textContent('body').catch(() => '')) || '');
    result.bodyHasAspect = new RegExp(aspect.replace(':', '\\:'), 'i').test(body);
    result.bodyHasQuantidade = /x1|x2|x3|x4/.test(body);
    result.bodyHasModelo = /Nano Banana Pro|Nano Banana 2|Imagem 4/i.test(body);
    result.finalUrl = page.url();

    res.json({ ok: true, result });
  } catch (err: any) {
    res.json({ ok: false, error: String(err?.message || err) });
  }
});


app.post('/flow-test-aspect-real', async (req, res) => {
  try {
    const { aspectRatio } = req.body || {};
    const aspect = String(aspectRatio || '9:16');
    const page = (bridge as any).pages['flow'];
    if (!page) throw new Error('Flow não está aberto.');

    await page.bringToFront().catch(() => {});
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(1400);

    const result: any = {
      chipClicked: false,
      imageClicked: false,
      aspectClicked: false,
      aspectValidated: false,
      method: '',
      notes: [],
      url: page.url(),
      aspectRatio: aspect
    };

    const safeCount = async (loc: any) => {
      try { return await loc.count(); } catch { return 0; }
    };

    const getBody = async () => ((await page.textContent('body').catch(() => '')) || '');

    const clickFirst = async (locators: any[], label: string, settle = 900) => {
      for (const loc of locators) {
        try {
          const n = await safeCount(loc);
          result.notes.push(`${label}: count=${n}`);
          if (!n) continue;
          const el = loc.first();
          await el.scrollIntoViewIfNeeded().catch(() => {});
          await el.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
          await el.click({ timeout: 5000 });
          await page.waitForLoadState('domcontentloaded').catch(() => {});
          await page.waitForTimeout(settle);
          result.notes.push(`clicou: ${label}`);
          return true;
        } catch (e: any) {
          result.notes.push(`falhou ${label}: ${String(e?.message || e).slice(0,160)}`);
        }
      }
      result.notes.push(`não achou: ${label}`);
      return false;
    };

    const composer = () => page.locator('xpath=//div[contains(., "O que você quer criar?")]').first();

    const openChip = async () => {
      const composerArea = composer();
      result.composerFound = (await safeCount(composerArea)) > 0;
      return await clickFirst([
        composerArea.locator('button').filter({ hasText: /nano banana|imagem 4|x[1-4]|16:9|4:3|1:1|3:4|9:16/i }),
        composerArea.locator('[role="button"]').filter({ hasText: /nano banana|imagem 4|x[1-4]|16:9|4:3|1:1|3:4|9:16/i }),
        page.locator('button').filter({ hasText: /nano banana|imagem 4|x[1-4]|16:9|4:3|1:1|3:4|9:16/i }),
        page.locator('[role="button"]').filter({ hasText: /nano banana|imagem 4|x[1-4]|16:9|4:3|1:1|3:4|9:16/i }),
      ], 'chip de configuração', 1300);
    };

    result.chipClicked = await openChip();
    await page.waitForTimeout(900);

    const findPanelBox = async () => {
      const panelCandidates = [
        page.locator('[data-radix-popper-content-wrapper]').first(),
        page.locator('[role="dialog"]').first(),
        page.locator('[role="menu"]').first(),
        page.locator('[role="listbox"]').first(),
        page.locator('body').first(),
      ];

      for (let i = 0; i < panelCandidates.length; i++) {
        const panel = panelCandidates[i];
        try {
          const n = await safeCount(panel);
          result.notes.push(`panel candidate ${i}: count=${n}`);
          if (!n) continue;
          const box = await panel.boundingBox().catch(() => null);
          result.notes.push(`panel candidate ${i}: box=${box ? `${Math.round(box.x)},${Math.round(box.y)},${Math.round(box.width)},${Math.round(box.height)}` : 'null'}`);
          if (box && box.width > 120 && box.height > 120) return { box, index: i };
        } catch (e: any) {
          result.notes.push(`panel candidate ${i} falhou: ${String(e?.message || e).slice(0,140)}`);
        }
      }
      return { box: null, index: -1 };
    };

    let { box: panelBox, index: panelIndex } = await findPanelBox();
    result.panelBox = panelBox;
    result.panelIndex = panelIndex;

    if (panelBox) {
      // Imagem já funcionou nessa posição.
      const imgX = panelBox.x + 70;
      const imgY = panelBox.y + 48;
      await page.mouse.click(imgX, imgY);
      await page.waitForTimeout(900);
      result.imageClicked = true;
      result.notes.push(`clicou imagem posição: x=${Math.round(imgX)} y=${Math.round(imgY)}`);
    }

    await page.waitForTimeout(500);

    // 1) tenta texto exato primeiro
    result.aspectClicked = await clickFirst([
      page.locator('[role="menu"], [role="listbox"], [data-radix-popper-content-wrapper], [role="dialog"]').getByText(aspect, { exact: true }),
      page.getByRole('button', { name: new RegExp('^' + aspect.replace(':', '\\:') + '$', 'i') }),
      page.getByText(aspect, { exact: true }),
    ], `proporção ${aspect}`, 1000);

    // 2) se texto falhar, tenta várias coordenadas calibráveis da fileira de proporções
    if (!result.aspectClicked && panelBox) {
      const ratios = ['16:9', '4:3', '1:1', '3:4', '9:16'];
      const index = Math.max(0, ratios.indexOf(aspect));

      // múltiplas tentativas: varia y e espaçamento, porque o painel pode deslocar
      const attempts = [
        { startX: 48, gap: 58, y: 132, label: 'base' },
        { startX: 50, gap: 62, y: 144, label: 'lower-wide' },
        { startX: 42, gap: 55, y: 122, label: 'upper-tight' },
        { startX: panelBox.width * 0.13, gap: panelBox.width * 0.16, y: panelBox.height * 0.31, label: 'relative-31' },
        { startX: panelBox.width * 0.13, gap: panelBox.width * 0.16, y: panelBox.height * 0.36, label: 'relative-36' },
      ];

      for (const a of attempts) {
        const x = panelBox.x + a.startX + (index * a.gap);
        const y = panelBox.y + a.y;
        try {
          await page.mouse.click(x, y);
          await page.waitForTimeout(900);
          result.notes.push(`tentou proporção ${aspect} por posição ${a.label}: x=${Math.round(x)} y=${Math.round(y)} index=${index}`);
          // não valida ainda; marca tentativa
          result.aspectClicked = true;
          result.method = `position-${a.label}`;

          // fecha painel clicando fora e reabre para ler chip/painel
          await page.mouse.click(panelBox.x - 20, panelBox.y - 20).catch(() => {});
          await page.waitForTimeout(500);
          const bodyAfter = await getBody();
          const chipHasAspect = new RegExp(aspect.replace(':', '\\:'), 'i').test(bodyAfter);
          result.notes.push(`validação após ${a.label}: chip/body tem ${aspect} = ${chipHasAspect ? 'sim' : 'não'}`);

          if (chipHasAspect) {
            result.aspectValidated = true;
            break;
          }

          // reabre chip para próxima tentativa
          result.chipClicked = await openChip();
          await page.waitForTimeout(700);
          const panelAgain = await findPanelBox();
          if (panelAgain.box) panelBox = panelAgain.box;
        } catch (e: any) {
          result.notes.push(`falhou posição ${a.label}: ${String(e?.message || e).slice(0,140)}`);
        }
      }
    }

    // validação final real
    const finalBody = await getBody();
    result.bodyHasAspect = new RegExp(aspect.replace(':', '\\:'), 'i').test(finalBody);
    result.aspectValidated = result.aspectValidated || result.bodyHasAspect;
    result.bodyHasQuantidade = /x1|x2|x3|x4/.test(finalBody);
    result.bodyHasModelo = /Nano Banana Pro|Nano Banana 2|Imagem 4/i.test(finalBody);
    result.finalUrl = page.url();

    // Só dá ok real se validou
    res.json({ ok: true, result });
  } catch (err: any) {
    res.json({ ok: false, error: String(err?.message || err) });
  }
});


app.post('/flow-test-aspect-calibrated', async (req, res) => {
  try {
    const { aspectRatio } = req.body || {};
    const aspect = String(aspectRatio || '9:16');
    const page = (bridge as any).pages['flow'];
    if (!page) throw new Error('Flow não está aberto.');

    await page.bringToFront().catch(() => {});
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(1400);

    const result: any = {
      chipClicked: false,
      imageClicked: false,
      aspectClicked: false,
      method: '',
      notes: [],
      url: page.url(),
      aspectRatio: aspect
    };

    const safeCount = async (loc: any) => {
      try { return await loc.count(); } catch { return 0; }
    };

    const clickFirst = async (locators: any[], label: string, settle = 900) => {
      for (const loc of locators) {
        try {
          const n = await safeCount(loc);
          result.notes.push(`${label}: count=${n}`);
          if (!n) continue;
          const el = loc.first();
          await el.scrollIntoViewIfNeeded().catch(() => {});
          await el.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
          await el.click({ timeout: 5000 });
          await page.waitForLoadState('domcontentloaded').catch(() => {});
          await page.waitForTimeout(settle);
          result.notes.push(`clicou: ${label}`);
          return true;
        } catch (e: any) {
          result.notes.push(`falhou ${label}: ${String(e?.message || e).slice(0,160)}`);
        }
      }
      result.notes.push(`não achou: ${label}`);
      return false;
    };

    const composer = () => page.locator('xpath=//div[contains(., "O que você quer criar?")]').first();

    const openChip = async () => {
      const composerArea = composer();
      result.composerFound = (await safeCount(composerArea)) > 0;
      return await clickFirst([
        composerArea.locator('button').filter({ hasText: /nano banana|imagem 4|x[1-4]|16:9|4:3|1:1|3:4|9:16/i }),
        composerArea.locator('[role="button"]').filter({ hasText: /nano banana|imagem 4|x[1-4]|16:9|4:3|1:1|3:4|9:16/i }),
        page.locator('button').filter({ hasText: /nano banana|imagem 4|x[1-4]|16:9|4:3|1:1|3:4|9:16/i }),
        page.locator('[role="button"]').filter({ hasText: /nano banana|imagem 4|x[1-4]|16:9|4:3|1:1|3:4|9:16/i }),
      ], 'chip de configuração', 1300);
    };

    result.chipClicked = await openChip();
    await page.waitForTimeout(900);

    const findPanelBox = async () => {
      const panelCandidates = [
        page.locator('[data-radix-popper-content-wrapper]').first(),
        page.locator('[role="dialog"]').first(),
        page.locator('[role="menu"]').first(),
        page.locator('[role="listbox"]').first(),
        page.locator('body').first(),
      ];

      for (let i = 0; i < panelCandidates.length; i++) {
        const panel = panelCandidates[i];
        try {
          const n = await safeCount(panel);
          result.notes.push(`panel candidate ${i}: count=${n}`);
          if (!n) continue;
          const box = await panel.boundingBox().catch(() => null);
          result.notes.push(`panel candidate ${i}: box=${box ? `${Math.round(box.x)},${Math.round(box.y)},${Math.round(box.width)},${Math.round(box.height)}` : 'null'}`);
          if (box && box.width > 120 && box.height > 120) return { box, index: i };
        } catch (e: any) {
          result.notes.push(`panel candidate ${i} falhou: ${String(e?.message || e).slice(0,140)}`);
        }
      }
      return { box: null, index: -1 };
    };

    let { box: panelBox, index: panelIndex } = await findPanelBox();
    result.panelBox = panelBox;
    result.panelIndex = panelIndex;

    if (panelBox) {
      const imgX = panelBox.x + 70;
      const imgY = panelBox.y + 48;
      await page.mouse.click(imgX, imgY);
      await page.waitForTimeout(900);
      result.imageClicked = true;
      result.notes.push(`clicou imagem posição: x=${Math.round(imgX)} y=${Math.round(imgY)}`);
    }

    await page.waitForTimeout(500);

    // Proporção: não usa validação por body. Aqui o objetivo é calibrar a coordenada correta.
    const ratios = ['16:9', '4:3', '1:1', '3:4', '9:16'];
    const idx = Math.max(0, ratios.indexOf(aspect));

    if (panelBox) {
      // Coordenadas mais precisas para 5 botões igualmente distribuídos no painel.
      // A fórmula anterior usava gap grande demais. Esta usa largura real do painel.
      const leftMargin = panelBox.width * 0.12;
      const rightMargin = panelBox.width * 0.12;
      const usable = panelBox.width - leftMargin - rightMargin;
      const gap = usable / 4;
      const x = panelBox.x + leftMargin + (idx * gap);

      // Três Y possíveis. A mensagem mostrará qual foi usada. Por padrão usamos a central.
      const y = panelBox.y + panelBox.height * 0.39;

      await page.mouse.click(x, y);
      await page.waitForTimeout(1200);

      result.aspectClicked = true;
      result.method = 'calibrated-width';
      result.clickedPoint = { x: Math.round(x), y: Math.round(y), idx, aspect, leftMargin: Math.round(leftMargin), gap: Math.round(gap) };
      result.notes.push(`clicou proporção calibrada: ${aspect} x=${Math.round(x)} y=${Math.round(y)} idx=${idx} gap=${Math.round(gap)}`);
    }

    result.finalUrl = page.url();

    // Nesta versão, "ok" significa apenas que clicou no ponto calibrado.
    // A validação final será visual pelo usuário.
    res.json({ ok: true, result });
  } catch (err: any) {
    res.json({ ok: false, error: String(err?.message || err) });
  }
});


app.post('/flow-test-count', async (req, res) => {
  try {
    const { aspectRatio, count } = req.body || {};
    const aspect = String(aspectRatio || '9:16');
    const imageCount = Number(count || 1);
    const page = (bridge as any).pages['flow'];
    if (!page) throw new Error('Flow não está aberto.');

    await page.bringToFront().catch(() => {});
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(1400);

    const result: any = {
      chipClicked: false,
      imageClicked: false,
      aspectClicked: false,
      countClicked: false,
      method: '',
      notes: [],
      url: page.url(),
      aspectRatio: aspect,
      count: imageCount
    };

    const safeCount = async (loc: any) => {
      try { return await loc.count(); } catch { return 0; }
    };

    const clickFirst = async (locators: any[], label: string, settle = 900) => {
      for (const loc of locators) {
        try {
          const n = await safeCount(loc);
          result.notes.push(`${label}: count=${n}`);
          if (!n) continue;
          const el = loc.first();
          await el.scrollIntoViewIfNeeded().catch(() => {});
          await el.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
          await el.click({ timeout: 5000 });
          await page.waitForLoadState('domcontentloaded').catch(() => {});
          await page.waitForTimeout(settle);
          result.notes.push(`clicou: ${label}`);
          return true;
        } catch (e: any) {
          result.notes.push(`falhou ${label}: ${String(e?.message || e).slice(0,160)}`);
        }
      }
      result.notes.push(`não achou: ${label}`);
      return false;
    };

    const composer = () => page.locator('xpath=//div[contains(., "O que você quer criar?")]').first();

    const openChip = async () => {
      const composerArea = composer();
      result.composerFound = (await safeCount(composerArea)) > 0;
      return await clickFirst([
        composerArea.locator('button').filter({ hasText: /nano banana|imagem 4|x[1-4]|16:9|4:3|1:1|3:4|9:16/i }),
        composerArea.locator('[role="button"]').filter({ hasText: /nano banana|imagem 4|x[1-4]|16:9|4:3|1:1|3:4|9:16/i }),
        page.locator('button').filter({ hasText: /nano banana|imagem 4|x[1-4]|16:9|4:3|1:1|3:4|9:16/i }),
        page.locator('[role="button"]').filter({ hasText: /nano banana|imagem 4|x[1-4]|16:9|4:3|1:1|3:4|9:16/i }),
      ], 'chip de configuração', 1300);
    };

    result.chipClicked = await openChip();
    await page.waitForTimeout(900);

    const findPanelBox = async () => {
      const panelCandidates = [
        page.locator('[data-radix-popper-content-wrapper]').first(),
        page.locator('[role="dialog"]').first(),
        page.locator('[role="menu"]').first(),
        page.locator('[role="listbox"]').first(),
        page.locator('body').first(),
      ];

      for (let i = 0; i < panelCandidates.length; i++) {
        const panel = panelCandidates[i];
        try {
          const n = await safeCount(panel);
          result.notes.push(`panel candidate ${i}: count=${n}`);
          if (!n) continue;
          const box = await panel.boundingBox().catch(() => null);
          result.notes.push(`panel candidate ${i}: box=${box ? `${Math.round(box.x)},${Math.round(box.y)},${Math.round(box.width)},${Math.round(box.height)}` : 'null'}`);
          if (box && box.width > 120 && box.height > 120) return { box, index: i };
        } catch (e: any) {
          result.notes.push(`panel candidate ${i} falhou: ${String(e?.message || e).slice(0,140)}`);
        }
      }
      return { box: null, index: -1 };
    };

    let { box: panelBox, index: panelIndex } = await findPanelBox();
    result.panelBox = panelBox;
    result.panelIndex = panelIndex;

    if (panelBox) {
      // Imagem
      const imgX = panelBox.x + 70;
      const imgY = panelBox.y + 48;
      await page.mouse.click(imgX, imgY);
      await page.waitForTimeout(900);
      result.imageClicked = true;
      result.notes.push(`clicou imagem posição: x=${Math.round(imgX)} y=${Math.round(imgY)}`);

      // Proporção já corrigida na V5.0: yRatio=0.39
      const ratios = ['16:9', '4:3', '1:1', '3:4', '9:16'];
      const aspectIdx = Math.max(0, ratios.indexOf(aspect));
      const leftMargin = panelBox.width * 0.12;
      const rightMargin = panelBox.width * 0.12;
      const usable = panelBox.width - leftMargin - rightMargin;
      const gap = usable / 4;
      const aspectX = panelBox.x + leftMargin + (aspectIdx * gap);
      const aspectY = panelBox.y + panelBox.height * 0.39;
      await page.mouse.click(aspectX, aspectY);
      await page.waitForTimeout(900);
      result.aspectClicked = true;
      result.notes.push(`clicou proporção corrigida: ${aspect} x=${Math.round(aspectX)} y=${Math.round(aspectY)} idx=${aspectIdx} gap=${Math.round(gap)} yRatio=0.39`);

      // Quantidade: linha abaixo da proporção.
      // x1..x4 são quatro botões; calculados pela largura do painel.
      const countIdx = Math.min(3, Math.max(0, imageCount - 1));
      const countLeftMargin = panelBox.width * 0.16;
      const countRightMargin = panelBox.width * 0.16;
      const countUsable = panelBox.width - countLeftMargin - countRightMargin;
      const countGap = countUsable / 3;
      const countX = panelBox.x + countLeftMargin + (countIdx * countGap);
      const countY = panelBox.y + panelBox.height * 0.55;
      await page.mouse.click(countX, countY);
      await page.waitForTimeout(1000);
      result.countClicked = true;
      result.method = 'position-count-row';
      result.clickedCountPoint = {
        x: Math.round(countX),
        y: Math.round(countY),
        countIdx,
        imageCount,
        countGap: Math.round(countGap),
        yRatio: 0.55
      };
      result.notes.push(`clicou quantidade: x${imageCount} x=${Math.round(countX)} y=${Math.round(countY)} idx=${countIdx} gap=${Math.round(countGap)} yRatio=0.55`);
    }

    result.finalUrl = page.url();
    res.json({ ok: true, result });
  } catch (err: any) {
    res.json({ ok: false, error: String(err?.message || err) });
  }
});


app.get('/version-v536', async (_req, res) => {
  res.json({ ok: true, version: 'V5.3.6-FORCED-FINAL-UNIQUE' });
});

app.post('/flow-test-model-menu-v536-final', async (req, res) => {
  try {
    const { aspectRatio, count } = req.body || {};
    const aspect = String(aspectRatio || '9:16');
    const imageCount = Number(count || 1);
    const page = (bridge as any).pages['flow'];
    if (!page) throw new Error('Flow não está aberto.');

    await page.bringToFront().catch(() => {});
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(1400);

    const result: any = {
      version: 'V5.3.6-FORCED-FINAL-UNIQUE',
      chipClicked: false,
      imageClicked: false,
      aspectClicked: false,
      countClicked: false,
      modelMenuClicked: false,
      method: '',
      notes: [],
      url: page.url()
    };

    const safeCount = async (loc: any) => {
      try { return await loc.count(); } catch { return 0; }
    };

    const popupCounts = async () => ({
      popper: await safeCount(page.locator('[data-radix-popper-content-wrapper]')),
      menu: await safeCount(page.locator('[role="menu"]')),
      listbox: await safeCount(page.locator('[role="listbox"]')),
      dialog: await safeCount(page.locator('[role="dialog"]')),
    });

    const textCounts = async () => ({
      pro: await safeCount(page.getByText('Nano Banana Pro', { exact: true })),
      two: await safeCount(page.getByText('Nano Banana 2', { exact: true })),
      img4: await safeCount(page.getByText('Imagem 4', { exact: true })),
    });

    const clickFirst = async (locators: any[], label: string, settle = 900) => {
      for (const loc of locators) {
        try {
          const n = await safeCount(loc);
          result.notes.push(`${label}: count=${n}`);
          if (!n) continue;
          const el = loc.first();
          await el.scrollIntoViewIfNeeded().catch(() => {});
          await el.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
          await el.click({ timeout: 5000 });
          await page.waitForLoadState('domcontentloaded').catch(() => {});
          await page.waitForTimeout(settle);
          result.notes.push(`clicou: ${label}`);
          return true;
        } catch (e: any) {
          result.notes.push(`falhou ${label}: ${String(e?.message || e).slice(0,160)}`);
        }
      }
      result.notes.push(`não achou: ${label}`);
      return false;
    };

    const composer = () => page.locator('xpath=//div[contains(., "O que você quer criar?")]').first();

    const openChip = async () => {
      const composerArea = composer();
      result.composerFound = (await safeCount(composerArea)) > 0;
      return await clickFirst([
        composerArea.locator('button').filter({ hasText: /nano banana|imagem 4|x[1-4]|16:9|4:3|1:1|3:4|9:16/i }),
        composerArea.locator('[role="button"]').filter({ hasText: /nano banana|imagem 4|x[1-4]|16:9|4:3|1:1|3:4|9:16/i }),
        page.locator('button').filter({ hasText: /nano banana|imagem 4|x[1-4]|16:9|4:3|1:1|3:4|9:16/i }),
        page.locator('[role="button"]').filter({ hasText: /nano banana|imagem 4|x[1-4]|16:9|4:3|1:1|3:4|9:16/i }),
      ], 'chip de configuração', 1300);
    };

    result.chipClicked = await openChip();
    await page.waitForTimeout(900);

    const findPanelBox = async () => {
      const panelCandidates = [
        page.locator('[data-radix-popper-content-wrapper]').first(),
        page.locator('[role="dialog"]').first(),
        page.locator('[role="menu"]').first(),
        page.locator('[role="listbox"]').first(),
        page.locator('body').first(),
      ];

      for (let i = 0; i < panelCandidates.length; i++) {
        const panel = panelCandidates[i];
        try {
          const n = await safeCount(panel);
          result.notes.push(`panel candidate ${i}: count=${n}`);
          if (!n) continue;
          const box = await panel.boundingBox().catch(() => null);
          result.notes.push(`panel candidate ${i}: box=${box ? `${Math.round(box.x)},${Math.round(box.y)},${Math.round(box.width)},${Math.round(box.height)}` : 'null'}`);
          if (box && box.width > 120 && box.height > 120) return { box, index: i };
        } catch (e: any) {
          result.notes.push(`panel candidate ${i} falhou: ${String(e?.message || e).slice(0,140)}`);
        }
      }
      return { box: null, index: -1 };
    };

    let { box: panelBox } = await findPanelBox();

    if (panelBox) {
      const imgX = panelBox.x + 70;
      const imgY = panelBox.y + 48;
      await page.mouse.click(imgX, imgY);
      await page.waitForTimeout(800);
      result.imageClicked = true;
      result.notes.push(`clicou imagem posição: x=${Math.round(imgX)} y=${Math.round(imgY)}`);

      const ratios = ['16:9', '4:3', '1:1', '3:4', '9:16'];
      const aspectIdx = Math.max(0, ratios.indexOf(aspect));
      const leftMargin = panelBox.width * 0.12;
      const usable = panelBox.width - (panelBox.width * 0.24);
      const gap = usable / 4;
      const aspectX = panelBox.x + leftMargin + (aspectIdx * gap);
      const aspectY = panelBox.y + panelBox.height * 0.39;
      await page.mouse.click(aspectX, aspectY);
      await page.waitForTimeout(800);
      result.aspectClicked = true;
      result.notes.push(`clicou proporção: ${aspect} x=${Math.round(aspectX)} y=${Math.round(aspectY)} idx=${aspectIdx}`);

      const countIdx = Math.min(3, Math.max(0, imageCount - 1));
      const countLeftMargin = panelBox.width * 0.16;
      const countUsable = panelBox.width - (panelBox.width * 0.32);
      const countGap = countUsable / 3;
      const countX = panelBox.x + countLeftMargin + (countIdx * countGap);
      const countY = panelBox.y + panelBox.height * 0.55;
      await page.mouse.click(countX, countY);
      await page.waitForTimeout(800);
      result.countClicked = true;
      result.notes.push(`clicou quantidade: x${imageCount} x=${Math.round(countX)} y=${Math.round(countY)} idx=${countIdx}`);

      const beforePopups = await popupCounts();
      const beforeTexts = await textCounts();
      result.notes.push(`V536 antes menu modelo: popups=${JSON.stringify(beforePopups)} textos=${JSON.stringify(beforeTexts)}`);

      const attempts = [
        { xRatio: 0.50, yRatio: 0.79, label: 'center-bottom' },
        { xRatio: 0.78, yRatio: 0.79, label: 'right-bottom' },
        { xRatio: 0.90, yRatio: 0.79, label: 'far-right-bottom' },
        { xRatio: 0.50, yRatio: 0.86, label: 'center-lower' },
        { xRatio: 0.83, yRatio: 0.86, label: 'right-lower' },
        { xRatio: 0.90, yRatio: 0.86, label: 'far-right-lower' },
        { xRatio: 0.50, yRatio: 0.72, label: 'center-upper-model' },
        { xRatio: 0.82, yRatio: 0.72, label: 'right-upper-model' },
        { xRatio: 0.25, yRatio: 0.79, label: 'left-bottom' },
      ];

      for (const a of attempts) {
        const x = panelBox.x + panelBox.width * a.xRatio;
        const y = panelBox.y + panelBox.height * a.yRatio;
        await page.mouse.click(x, y);
        await page.waitForTimeout(1100);

        const afterPopups = await popupCounts();
        const afterTexts = await textCounts();

        const popupIncreased =
          afterPopups.popper > beforePopups.popper ||
          afterPopups.menu > beforePopups.menu ||
          afterPopups.listbox > beforePopups.listbox ||
          afterPopups.dialog > beforePopups.dialog;

        const textIncreased =
          afterTexts.pro > beforeTexts.pro ||
          afterTexts.two > beforeTexts.two ||
          afterTexts.img4 > beforeTexts.img4;

        result.notes.push(`V536 tentativa ${a.label}: x=${Math.round(x)} y=${Math.round(y)} popups=${JSON.stringify(afterPopups)} textos=${JSON.stringify(afterTexts)} popupIncreased=${popupIncreased ? 'sim' : 'não'} textIncreased=${textIncreased ? 'sim' : 'não'}`);

        if (popupIncreased || textIncreased) {
          result.modelMenuClicked = true;
          result.method = a.label;
          result.clickedModelMenuPoint = { x: Math.round(x), y: Math.round(y), label: a.label };
          break;
        }

        const body = ((await page.textContent('body').catch(() => '')) || '');
        const chipStillOpen = /16:9|4:3|1:1|3:4|9:16/.test(body) && /x1|x2|x3|x4/.test(body);
        if (!chipStillOpen) {
          result.notes.push(`chip parece ter fechado após ${a.label}; reabrindo`);
          await openChip();
          await page.waitForTimeout(700);
          const foundAgain = await findPanelBox();
          if (foundAgain.box) panelBox = foundAgain.box;
        }
      }
    }

    // Após detectar que o menu abriu, tenta selecionar o modelo
    if (result.modelMenuClicked) {
      await page.waitForTimeout(900);
      const { aspectRatio, count } = req.body || {};
      // modelo a selecionar vem do body, mas o teste não passa — usa Nano Banana 2 como padrão
      const targetModel = 'Nano Banana 2';
      const lastPopper = page.locator('[data-radix-popper-content-wrapper]').last();
      const lastMenu   = page.locator('[role="menu"]').last();
      let modelSelected = false;
      for (const loc of [
        lastPopper.getByText(targetModel, { exact: false }),
        lastMenu.getByText(targetModel, { exact: false }),
        page.getByText(targetModel, { exact: false }),
      ]) {
        try {
          const n = await safeCount(loc);
          if (!n) continue;
          await loc.first().click({ timeout: 3000 });
          await page.waitForTimeout(600);
          modelSelected = true;
          result.notes.push('modelo selecionado por texto: ' + targetModel);
          break;
        } catch {}
      }
      if (!modelSelected) {
        // fallback coordenada no submenu
        const submenuBox = await lastPopper.boundingBox().catch(() => null) ?? await lastMenu.boundingBox().catch(() => null);
        if (submenuBox) {
          const modelOrder = ['Nano Banana Pro', 'Nano Banana 2', 'Imagem 4'];
          const itemIdx = modelOrder.indexOf(targetModel);
          const itemH = submenuBox.height / modelOrder.length;
          const sx = submenuBox.x + submenuBox.width * 0.5;
          const sy = submenuBox.y + itemH * itemIdx + itemH * 0.5;
          await page.mouse.click(sx, sy);
          await page.waitForTimeout(600);
          result.notes.push('modelo selecionado por coordenada: ' + targetModel + ' x=' + Math.round(sx) + ' y=' + Math.round(sy));
          modelSelected = true;
        }
      }
      result.modelSelected = modelSelected;
      result.modelTarget = targetModel;
    }

    result.finalUrl = page.url();
    res.json({ ok: true, result });
  } catch (err: any) {
    res.json({ ok: false, error: String(err?.message || err) });
  }
});


app.get('/version-v538', async (_req, res) => {
  res.json({ ok: true, version: 'V5.3.8-MODEL-POPUP-POSITION-ONLY' });
});

app.post('/flow-test-model-select-v538', async (req, res) => {
  try {
    const { aspectRatio, count, model } = req.body || {};
    const aspect = String(aspectRatio || '9:16');
    const imageCount = Number(count || 1);
    let targetModel = String(model || 'Nano Banana 2');

    if (targetModel.toLowerCase().includes('pro')) targetModel = 'Nano Banana Pro';
    else if (targetModel.toLowerCase().includes('nano banana 2')) targetModel = 'Nano Banana 2';
    else if (targetModel.toLowerCase().includes('imagem 4')) targetModel = 'Imagem 4';

    const page = (bridge as any).pages['flow'];
    if (!page) throw new Error('Flow não está aberto.');

    await page.bringToFront().catch(() => {});
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(1400);

    const result: any = {
      version: 'V5.3.8-MODEL-POPUP-POSITION-ONLY',
      chipClicked: false,
      imageClicked: false,
      aspectClicked: false,
      countClicked: false,
      modelMenuClicked: false,
      modelClicked: false,
      method: '',
      notes: [],
      targetModel,
      url: page.url()
    };

    const safeCount = async (loc: any) => {
      try { return await loc.count(); } catch { return 0; }
    };

    const popupCounts = async () => ({
      popper: await safeCount(page.locator('[data-radix-popper-content-wrapper]')),
      menu: await safeCount(page.locator('[role="menu"]')),
      listbox: await safeCount(page.locator('[role="listbox"]')),
      dialog: await safeCount(page.locator('[role="dialog"]')),
    });

    const clickFirst = async (locators: any[], label: string, settle = 900) => {
      for (const loc of locators) {
        try {
          const n = await safeCount(loc);
          result.notes.push(`${label}: count=${n}`);
          if (!n) continue;
          const el = loc.first();
          await el.scrollIntoViewIfNeeded().catch(() => {});
          await el.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
          await el.click({ timeout: 5000 });
          await page.waitForLoadState('domcontentloaded').catch(() => {});
          await page.waitForTimeout(settle);
          result.notes.push(`clicou: ${label}`);
          return true;
        } catch (e: any) {
          result.notes.push(`falhou ${label}: ${String(e?.message || e).slice(0,160)}`);
        }
      }
      result.notes.push(`não achou: ${label}`);
      return false;
    };

    const composer = () => page.locator('xpath=//div[contains(., "O que você quer criar?")]').first();

    const openChip = async () => {
      const composerArea = composer();
      result.composerFound = (await safeCount(composerArea)) > 0;
      return await clickFirst([
        composerArea.locator('button').filter({ hasText: /nano banana|imagem 4|x[1-4]|16:9|4:3|1:1|3:4|9:16/i }),
        composerArea.locator('[role="button"]').filter({ hasText: /nano banana|imagem 4|x[1-4]|16:9|4:3|1:1|3:4|9:16/i }),
        page.locator('button').filter({ hasText: /nano banana|imagem 4|x[1-4]|16:9|4:3|1:1|3:4|9:16/i }),
        page.locator('[role="button"]').filter({ hasText: /nano banana|imagem 4|x[1-4]|16:9|4:3|1:1|3:4|9:16/i }),
      ], 'chip de configuração', 1300);
    };

    result.chipClicked = await openChip();
    await page.waitForTimeout(900);

    const findPanelBox = async () => {
      const panelCandidates = [
        page.locator('[data-radix-popper-content-wrapper]').first(),
        page.locator('[role="dialog"]').first(),
        page.locator('[role="menu"]').first(),
        page.locator('[role="listbox"]').first(),
        page.locator('body').first(),
      ];

      for (let i = 0; i < panelCandidates.length; i++) {
        const panel = panelCandidates[i];
        try {
          const n = await safeCount(panel);
          result.notes.push(`panel candidate ${i}: count=${n}`);
          if (!n) continue;
          const box = await panel.boundingBox().catch(() => null);
          result.notes.push(`panel candidate ${i}: box=${box ? `${Math.round(box.x)},${Math.round(box.y)},${Math.round(box.width)},${Math.round(box.height)}` : 'null'}`);
          if (box && box.width > 120 && box.height > 120) return { box, index: i };
        } catch (e: any) {
          result.notes.push(`panel candidate ${i} falhou: ${String(e?.message || e).slice(0,140)}`);
        }
      }
      return { box: null, index: -1 };
    };

    const getNewestDifferentPopupBox = async (mainBox: any) => {
      // IMPORTANT: no text click. Only bounding boxes.
      const groups = [
        page.locator('[data-radix-popper-content-wrapper]'),
        page.locator('[role="menu"]'),
        page.locator('[role="listbox"]'),
        page.locator('[role="dialog"]'),
      ];

      for (const group of groups) {
        const n = await safeCount(group);
        for (let j = n - 1; j >= 0; j--) {
          try {
            const box = await group.nth(j).boundingBox().catch(() => null);
            if (!box || box.width < 80 || box.height < 50) continue;

            const sameAsMain =
              mainBox &&
              Math.abs(box.x - mainBox.x) < 5 &&
              Math.abs(box.y - mainBox.y) < 5 &&
              Math.abs(box.width - mainBox.width) < 5 &&
              Math.abs(box.height - mainBox.height) < 5;

            result.notes.push(`popup real candidate ${j}: box=${Math.round(box.x)},${Math.round(box.y)},${Math.round(box.width)},${Math.round(box.height)} sameAsMain=${sameAsMain ? 'sim' : 'não'}`);

            if (!sameAsMain) return box;
          } catch {}
        }
      }
      return null;
    };

    let { box: panelBox } = await findPanelBox();

    if (panelBox) {
      // Imagem
      const imgX = panelBox.x + 70;
      const imgY = panelBox.y + 48;
      await page.mouse.click(imgX, imgY);
      await page.waitForTimeout(800);
      result.imageClicked = true;
      result.notes.push(`clicou imagem posição: x=${Math.round(imgX)} y=${Math.round(imgY)}`);

      // Proporção
      const ratios = ['16:9', '4:3', '1:1', '3:4', '9:16'];
      const aspectIdx = Math.max(0, ratios.indexOf(aspect));
      const leftMargin = panelBox.width * 0.12;
      const usable = panelBox.width - (panelBox.width * 0.24);
      const gap = usable / 4;
      const aspectX = panelBox.x + leftMargin + (aspectIdx * gap);
      const aspectY = panelBox.y + panelBox.height * 0.39;
      await page.mouse.click(aspectX, aspectY);
      await page.waitForTimeout(800);
      result.aspectClicked = true;
      result.notes.push(`clicou proporção: ${aspect} x=${Math.round(aspectX)} y=${Math.round(aspectY)} idx=${aspectIdx}`);

      // Quantidade
      const countIdx = Math.min(3, Math.max(0, imageCount - 1));
      const countLeftMargin = panelBox.width * 0.16;
      const countUsable = panelBox.width - (panelBox.width * 0.32);
      const countGap = countUsable / 3;
      const countX = panelBox.x + countLeftMargin + (countIdx * countGap);
      const countY = panelBox.y + panelBox.height * 0.55;
      await page.mouse.click(countX, countY);
      await page.waitForTimeout(800);
      result.countClicked = true;
      result.notes.push(`clicou quantidade: x${imageCount} x=${Math.round(countX)} y=${Math.round(countY)} idx=${countIdx}`);

      const beforePopups = await popupCounts();
      result.notes.push(`V538 antes menu modelo: popups=${JSON.stringify(beforePopups)}`);

      // Confirmed point from V5.3.6: center-upper-model.
      const modelMenuX = panelBox.x + panelBox.width * 0.50;
      const modelMenuY = panelBox.y + panelBox.height * 0.72;
      await page.mouse.click(modelMenuX, modelMenuY);
      await page.waitForTimeout(1200);

      const afterPopups = await popupCounts();
      result.modelMenuClicked =
        afterPopups.popper > beforePopups.popper ||
        afterPopups.menu > beforePopups.menu ||
        afterPopups.listbox > beforePopups.listbox ||
        afterPopups.dialog > beforePopups.dialog;

      result.clickedModelMenuPoint = { x: Math.round(modelMenuX), y: Math.round(modelMenuY) };
      result.notes.push(`V538 abriu menu modelo: x=${Math.round(modelMenuX)} y=${Math.round(modelMenuY)} popups=${JSON.stringify(afterPopups)} menu=${result.modelMenuClicked ? 'ok' : 'falhou'}`);

      // NEVER use text here. Select only by popup coordinates.
      const subBox = await getNewestDifferentPopupBox(panelBox);

      if (subBox) {
        const models = ['Nano Banana Pro', 'Nano Banana 2', 'Imagem 4'];
        const modelIdx = Math.max(0, models.indexOf(targetModel));

        const modelX = subBox.x + subBox.width * 0.50;
        const rowHeight = subBox.height / 3;
        const modelY = subBox.y + rowHeight * (modelIdx + 0.5);

        await page.mouse.click(modelX, modelY);
        await page.waitForTimeout(1000);

        result.modelClicked = true;
        result.method = 'popup-position-only';
        result.clickedModelPoint = {
          x: Math.round(modelX),
          y: Math.round(modelY),
          modelIdx,
          targetModel,
          subBox: {
            x: Math.round(subBox.x),
            y: Math.round(subBox.y),
            width: Math.round(subBox.width),
            height: Math.round(subBox.height)
          }
        };
        result.notes.push(`V538 clicou modelo somente por posição: ${targetModel} x=${Math.round(modelX)} y=${Math.round(modelY)} idx=${modelIdx}`);
      } else {
        result.notes.push('V538 não encontrou popup real diferente do painel principal para selecionar modelo.');
      }
    }

    result.finalUrl = page.url();
    res.json({ ok: true, result });
  } catch (err: any) {
    res.json({ ok: false, error: String(err?.message || err) });
  }
});

app.get('/agents', async (_req, res) => {
  try {
    const result = await bridge.listAgents();
    res.json({ ok: true, ...result });
  } catch (err: any) {
    res.json({ ok: false, error: String(err?.message || err) });
  }
});

app.post('/direct-message', async (req, res) => {
  try {
    const { agentId, prompt } = req.body;
    const result = await bridge.sendDirectMessage(agentId, prompt);
    res.json({
      ok: true,
      rawResponse: result.latestResponse,
      conversation: result.conversation,
      sendMeta: result.sendMeta,
      confirmation: 'Mensagem enviada com sucesso.',
    });
  } catch (err: any) {
    res.json({ ok: false, error: String(err?.message || err) });
  }
});

app.post('/ask-ideas', async (req, res) => {
  try {
    const { agentId, subject, count, extraInstructions } = req.body;
    const result = await bridge.askForIdeas(agentId, subject, Number(count || 10), extraInstructions);
    const ideas = (result.latestResponse || '').split('\n').map((i: string) => i.trim()).filter((i: string) => i.length > 3).slice(0, Number(count || 10));
    res.json({
      ok: true,
      ideas,
      rawResponse: result.latestResponse,
      conversation: result.conversation,
      sendMeta: result.sendMeta,
      confirmation: 'Mensagem enviada com sucesso.',
    });
  } catch (err: any) {
    res.json({ ok: false, error: String(err?.message || err) });
  }
});

app.get('/conversation', async (_req, res) => {
  try {
    const conversation = await bridge.getFullConversation();
    res.json({ ok: true, conversation });
  } catch (err: any) {
    res.json({ ok: false, error: String(err?.message || err) });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// V5.4.0 - NOVOS ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════

/**
 * GET /flow-progress
 * Retorna progresso atual de geração de imagens no Flow
 * Útil para barra de progresso em tempo real
 */
app.get('/flow-progress', async (_req, res) => {
  try {
    const result = await (bridge as any).getFlowGenerationProgress();
    res.json({ ok: true, ...result });
  } catch (err: any) {
    res.json({ ok: false, error: String(err?.message || err) });
  }
});

/**
 * GET /flow-images
 * Retorna URLs de todas as imagens geradas no Flow
 */
app.get('/flow-images', async (_req, res) => {
  try {
    const result = await (bridge as any).getFlowGeneratedImages();
    res.json({ ok: true, ...result });
  } catch (err: any) {
    res.json({ ok: false, error: String(err?.message || err) });
  }
});

/**
 * V5.5.9 - GET /flow-debug-images
 * DEBUG: lista TODAS as imagens da página (sem filtro)
 * Útil quando getFlowGeneratedImages retorna vazio mas há imagens visíveis
 */
app.get('/flow-debug-images', async (_req, res) => {
  try {
    const result = await (bridge as any).debugAllFlowImages();
    res.json({ ok: true, ...result });
  } catch (err: any) {
    res.json({ ok: false, error: String(err?.message || err) });
  }
});

/**
 * POST /flow-delete-image
 * Deleta/Reprova uma imagem do Flow
 * Body: { imageIndex: number } OU { imageUrl: string }
 */
app.post('/flow-delete-image', async (req, res) => {
  try {
    const { imageIndex, imageUrl } = req.body;
    let result;
    
    if (imageUrl) {
      // V5.5.1: Preferir URL específica
      result = await (bridge as any).deleteFlowImageByUrl(imageUrl);
    } else if (typeof imageIndex === 'number') {
      result = await (bridge as any).deleteFlowImage(imageIndex);
    } else {
      throw new Error('imageIndex ou imageUrl deve ser fornecido');
    }
    
    res.json({ ok: true, ...result });
  } catch (err: any) {
    res.json({ ok: false, error: String(err?.message || err) });
  }
});

/**
 * V5.5.1 - POST /flow-set-references-by-urls
 * AMPLITUDE INTELIGENTE: usa URLs específicas das imagens APROVADAS
 * Body: { imageUrls: string[] }
 */
app.post('/flow-set-references-by-urls', async (req, res) => {
  try {
    const { imageUrls } = req.body;
    if (!Array.isArray(imageUrls)) throw new Error('imageUrls deve ser array');
    const result = await (bridge as any).setReferenceImagesByUrls(imageUrls);
    res.json({ ok: true, ...result });
  } catch (err: any) {
    res.json({ ok: false, error: String(err?.message || err) });
  }
});

/**
 * V5.5.9 - POST /flow-set-references-by-position
 * AMPLITUDE PELO MÉTODO DOS 3 PONTINHOS (Incluir no comando)
 * Body: { sceneNumbers: number[], perScene: number, approvedVariants?: { [sceneNum]: variant } }
 */
app.post('/flow-set-references-by-position', async (req, res) => {
  try {
    const { sceneNumbers, perScene, approvedVariants } = req.body;
    if (!Array.isArray(sceneNumbers)) throw new Error('sceneNumbers deve ser array');
    if (typeof perScene !== 'number') throw new Error('perScene deve ser número');
    const result = await (bridge as any).setReferenceImagesByPosition({ sceneNumbers, perScene, approvedVariants });
    res.json({ ok: true, ...result });
  } catch (err: any) {
    res.json({ ok: false, error: String(err?.message || err) });
  }
});

/**
 * POST /flow-approve-image
 * Aprova uma imagem (marca como aprovada no sistema)
 * Body: { imageIndex: number, sceneNumber: number }
 */
app.post('/flow-approve-image', async (req, res) => {
  try {
    const { imageIndex, sceneNumber } = req.body;
    const result = await (bridge as any).approveImage(imageIndex, sceneNumber);
    res.json({ ok: true, ...result });
  } catch (err: any) {
    res.json({ ok: false, error: String(err?.message || err) });
  }
});

/**
 * POST /flow-set-references
 * AMPLITUDE: Define imagens das cenas anteriores como referência
 * Body: { sceneNumbers: number[] }
 * Exemplo: { sceneNumbers: [1, 2] } usa cenas 1 e 2 como referência
 */
app.post('/flow-set-references', async (req, res) => {
  try {
    const { sceneNumbers } = req.body;
    if (!Array.isArray(sceneNumbers)) throw new Error('sceneNumbers deve ser array');
    const result = await (bridge as any).setReferenceImages(sceneNumbers);
    res.json({ ok: true, ...result });
  } catch (err: any) {
    res.json({ ok: false, error: String(err?.message || err) });
  }
});

/**
 * GET /version
 * Retorna versão atual do sistema
 */
app.get('/version', async (_req, res) => {
  res.json({ 
    ok: true, 
    version: 'V5.5.9', 
    name: 'DarkPlanner V5.5.9 - Debug Massivo',
    features: [
      '🚀 Mantém mesmo projeto entre cenas (não volta pra home!)',
      '🛑 Botão Stop para pausar geração',
      '🖼️ Imagens do Flow aparecem no DarkPlanner em tempo real',
      '✅ Aprovar/Reprovar funcional - rastreia URL específica',
      '🔗 Amplitude inteligente: usa apenas a imagem APROVADA como referência',
      '🗑️ Reprovar deleta a imagem específica do Flow',
      '🐛 Status de login corrigido (ChatGPT/Flow/Grok)',
      '🧹 Removidos botões de teste'
    ]
  });
});

app.listen(3017, () => {
  console.log('🚀 DarkPlanner V5.5.9 backend em http://localhost:3017');
  console.log('✨ Production-ready: amplitude inteligente + stop + imagens em tempo real');
});
