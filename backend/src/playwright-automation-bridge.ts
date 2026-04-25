
import { chromium, BrowserContext, Page } from 'playwright';
import fs from 'fs';
import path from 'path';

const RUNTIME_DIR = './runtime';
const PROFILE_DIR = path.join(RUNTIME_DIR, 'profiles');

type ServiceName = 'chatgpt' | 'flow' | 'grok';
type ChatMessage = { role: 'user' | 'assistant'; text: string };

const URLS = {
  chatgpt: 'https://chat.openai.com',
  flow: 'https://labs.google/fx/pt/tools/flow',
  grok: 'https://grok.com',
};

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export class AutomationBridge {
  contexts: Partial<Record<ServiceName, BrowserContext>> = {};
  pages: Partial<Record<ServiceName, Page>> = {};
  currentAgentId: string | null = null;
  initializedHiddenChat = false;

  async init() {
    ensureDir(RUNTIME_DIR);
    ensureDir(PROFILE_DIR);
  }

  private getUserDataDir(name: ServiceName) {
    const dir = path.join(PROFILE_DIR, name);
    ensureDir(dir);
    return dir;
  }

  async closeService(name: ServiceName) {
    if (this.contexts[name]) {
      try { await this.contexts[name]!.close(); } catch {}
    }
    delete this.contexts[name];
    delete this.pages[name];
    if (name === 'chatgpt') this.initializedHiddenChat = false;
  }

  private async isPageAlive(name: ServiceName) {
    try {
      const page = this.pages[name];
      if (!page) return false;
      page.url();
      return !page.isClosed();
    } catch {
      return false;
    }
  }

  async launchPersistentProfile(name: ServiceName, options?: { visible?: boolean; targetUrl?: string }) {
    const visible = options?.visible ?? false;
    const targetUrl = options?.targetUrl || URLS[name];
    const userDataDir = this.getUserDataDir(name);

    if (this.contexts[name] && this.pages[name] && await this.isPageAlive(name)) {
      return { context: this.contexts[name]!, page: this.pages[name]!, userDataDir };
    }

    const args = ['--disable-blink-features=AutomationControlled'];
    if (visible) {
      args.push('--start-maximized');
    } else {
      // Janela em segundo plano: coordenada positiva longe da área visível.
      // 9000,9000 é válido no Windows (não causa crash como -32000)
      // e fica fora de qualquer monitor comum (até 4K/ultrawide).
      args.push('--window-position=9000,9000');
      args.push('--window-size=1400,900');
    }

    let context: any;
    try {
      context = await chromium.launchPersistentContext(userDataDir, {
        headless: false,
        channel: 'chrome',
        viewport: { width: 1400, height: 900 },
        slowMo: visible ? 50 : 0,
        args,
      });
    } catch (err: any) {
      // Fallback: se o Chrome do sistema falhar, tenta fechar e reabrir
      console.warn(`[Bridge] Falha ao lançar Chrome para "${name}", tentando limpar e relançar...`, err?.message || err);
      await this.closeService(name);
      context = await chromium.launchPersistentContext(userDataDir, {
        headless: false,
        channel: 'chrome',
        viewport: { width: 1400, height: 900 },
        slowMo: visible ? 50 : 0,
        args,
      });
    }

    let page = context.pages()[0];
    if (!page) page = await context.newPage();

    // Em segundo plano: minimiza via eval do window.blur para não roubar foco
    if (!visible) {
      await page.evaluate(() => { try { window.blur(); } catch {} }).catch(() => {});
    }

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    this.contexts[name] = context;
    this.pages[name] = page;
    return { context, page, userDataDir };
  }

  async ensureContext(name: ServiceName, options?: { visible?: boolean; targetUrl?: string }) {
    if (!this.contexts[name] || !this.pages[name] || !(await this.isPageAlive(name))) {
      await this.closeService(name);
      await this.launchPersistentProfile(name, { visible: options?.visible ?? false, targetUrl: options?.targetUrl });
    }
    return { context: this.contexts[name]!, page: this.pages[name]! };
  }

  async initializeHiddenChatGPT() {
    if (this.initializedHiddenChat && await this.isPageAlive('chatgpt')) return;
    await this.ensureContext('chatgpt', { visible: false });
    this.initializedHiddenChat = true;
  }

  async firstTimeLogin() {
    console.log('🔐 Faça login manual nas janelas persistentes abertas...');
    await this.launchPersistentProfile('chatgpt', { visible: true });
    await this.launchPersistentProfile('flow', { visible: true });
    await this.launchPersistentProfile('grok', { visible: true });
    console.log('👉 O login agora fica salvo no perfil persistente do Chrome.');
    console.log('👉 Depois pressione ENTER no terminal.');
    await new Promise((resolve) => process.stdin.once('data', resolve));
    console.log('✅ Perfis persistentes preparados.');
  }

  async openVisibleService(name: ServiceName) {
    // Se o contexto de fundo já existe, apenas traz a janela para frente
    // sem fechar — preserva sessão e cookies.
    if (this.pages[name] && await this.isPageAlive(name)) {
      const page = this.pages[name]!;
      // Move a janela para posição visível via CDP (funciona no Windows)
      try {
        const session = await page.context().newCDPSession(page);
        await session.send('Browser.setWindowBounds', {
          windowId: (await session.send('Browser.getWindowForTarget')).windowId,
          bounds: { left: 100, top: 100, width: 1400, height: 900, windowState: 'normal' },
        });
        await session.detach();
      } catch {
        // fallback: tenta via bringToFront
      }
      await page.bringToFront().catch(() => {});
      return { ok: true };
    }
    // Se não existe contexto, cria um novo visível
    await this.launchPersistentProfile(name, { visible: true, targetUrl: URLS[name] });
    return { ok: true };
  }

  async getChatGPTStatus() {
    await this.initializeHiddenChatGPT();
    const { page } = await this.ensureContext('chatgpt', { visible: false });
    const currentUrl = page.url();
    let inputExists = 0;
    try {
      inputExists = await page.locator('[contenteditable="true"], textarea').count();
    } catch {
      inputExists = 0;
    }
    const looksLogged = inputExists > 0 || currentUrl.includes('/c/') || currentUrl.includes('/g/');
    return {
      mode: 'send_fix_status',
      loggedInLikely: looksLogged,
      currentUrl,
      backendSessionReady: Boolean(this.contexts.chatgpt && this.pages.chatgpt),
    };
  }

  async listAgents() {
    await this.initializeHiddenChatGPT();
    const { page } = await this.ensureContext('chatgpt', { visible: false, targetUrl: 'https://chatgpt.com/gpts' });
    await page.goto('https://chatgpt.com/gpts', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(1800);

    const links = await page.evaluate(() => {
      const items: Array<{name:string; href:string}> = [];
      document.querySelectorAll('a').forEach((a) => {
        const text = (a.textContent || '').trim().replace(/\s+/g, ' ');
        const href = (a as HTMLAnchorElement).href || '';
        if (href.includes('/g/') && text) items.push({ name: text, href });
      });
      return items;
    });

    const uniq = new Map<string, {id:string; name:string; source:'real'; href:string}>();
    for (const item of links) {
      if (!uniq.has(item.href)) uniq.set(item.href, { id: item.href, name: item.name, source: 'real', href: item.href });
    }
    const agents = Array.from(uniq.values()).slice(0, 50);

    if (agents.length) return { agents, mode: 'real', note: 'Lista filtrada para links de GPT.' };
    return {
      agents: [{ id: 'manual-chatgpt-agent', name: 'Agente manual já aberto no ChatGPT', source: 'fallback', href: '' }],
      mode: 'fallback',
      note: 'Fallback manual.',
    };
  }

  async ensureAgentConversation(agentId: string) {
    await this.initializeHiddenChatGPT();
    const { page } = await this.ensureContext('chatgpt', { visible: false });

    if (agentId && agentId !== 'manual-chatgpt-agent' && agentId.includes('/g/')) {
      if (this.currentAgentId !== agentId || !page.url().includes('/g/')) {
        await page.goto(agentId, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
        await page.waitForTimeout(2500);
        this.currentAgentId = agentId;
      }
    } else if (!page.url().includes('chat.openai.com') && !page.url().includes('chatgpt.com')) {
      await page.goto(URLS.chatgpt, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await page.waitForTimeout(1500);
    }

    const selectors = ['[contenteditable="true"]', 'textarea', 'div[contenteditable="true"]'];
    for (const selector of selectors) {
      const count = await page.locator(selector).count().catch(() => 0);
      if (count > 0) return { page, selector };
    }

    await page.waitForSelector('[contenteditable="true"], textarea', { timeout: 30000 });
    return { page, selector: '[contenteditable="true"]' };
  }

  async getFullConversation(): Promise<ChatMessage[]> {
    await this.initializeHiddenChatGPT();
    const { page } = await this.ensureContext('chatgpt', { visible: false });
    await page.waitForTimeout(1000);
    return await page.evaluate(() => {
      const out: Array<{role:'user'|'assistant'; text:string}> = [];
      document.querySelectorAll('[data-message-author-role]').forEach((node) => {
        const role = node.getAttribute('data-message-author-role');
        const text = (node.textContent || '').trim();
        if (text && (role === 'user' || role === 'assistant')) out.push({ role: role as 'user'|'assistant', text });
      });
      return out;
    });
  }

  async sendPrompt(prompt: string, agentId?: string) {
    const { page, selector } = await this.ensureAgentConversation(agentId || '');
    const before = await this.getFullConversation();
    const beforeUserCount = before.filter(x => x.role === 'user').length;

    const input = page.locator(selector).first();
    await input.click({ timeout: 10000 }).catch(() => {});
    await page.keyboard.press('Control+A').catch(() => {});
    await page.keyboard.press('Backspace').catch(() => {});
    await page.keyboard.type(prompt, { delay: 8 });

    let clicked = false;
    const buttonSelectors = [
      'button[data-testid="send-button"]',
      'button[aria-label*="Send"]',
      'button[aria-label*="Enviar"]'
    ];

    for (const sel of buttonSelectors) {
      const count = await page.locator(sel).count().catch(() => 0);
      if (count > 0) {
        try {
          await page.locator(sel).first().click({ timeout: 5000 });
          clicked = true;
          break;
        } catch {}
      }
    }

    if (!clicked) {
      await page.keyboard.press('Enter').catch(() => {});
    }

    await page.waitForFunction((prevCount) => {
      const messages = Array.from(document.querySelectorAll('[data-message-author-role="user"]'));
      return messages.length > prevCount;
    }, beforeUserCount, { timeout: 30000 }).catch(async () => {
      await page.waitForTimeout(3000);
    });

    return { sent: true, usedSelector: selector };
  }

  async waitForAssistantUpdate(previousAssistantCount: number) {
    const { page } = await this.ensureContext('chatgpt', { visible: false });
    await page.waitForFunction((prevCount) => {
      const messages = document.querySelectorAll('[data-message-author-role="assistant"]');
      return messages.length > prevCount;
    }, previousAssistantCount, { timeout: 120000 }).catch(async () => {
      await page.waitForTimeout(7000);
    });

    await page.waitForTimeout(5000);
  }

  async sendDirectMessage(agentId: string, prompt: string) {
    const beforeConversation = await this.getFullConversation().catch(() => []);
    const assistantBefore = beforeConversation.filter(x => x.role === 'assistant').length;

    const sendMeta = await this.sendPrompt(prompt, agentId);
    await this.waitForAssistantUpdate(assistantBefore);

    const conversation = await this.getFullConversation();
    const assistants = conversation.filter((x) => x.role === 'assistant');
    return {
      latestResponse: assistants.length ? assistants[assistants.length - 1].text : '',
      conversation,
      sendMeta,
    };
  }

  async askForIdeas(agentId: string, subject: string, count: number, extraInstructions?: string) {
    const prompt = `Quero ${count} ideias de vídeos sobre o seguinte assunto: ${subject}. Retorne as ideias de forma clara e separada. ${extraInstructions || ''}`;
    return await this.sendDirectMessage(agentId, prompt);
  }

  async close() {
    for (const key of Object.keys(this.contexts) as ServiceName[]) {
      try { await this.contexts[key]?.close(); } catch {}
    }
    this.contexts = {};
    this.pages = {};
  }

  async getServiceStatus(name: ServiceName) {
    // Não abre novo contexto se o serviço ainda não foi iniciado pelo usuário.
    // Evita abrir 3 browsers Chromium invisíveis desnecessariamente no startup.
    if (!this.contexts[name] || !this.pages[name] || !(await this.isPageAlive(name))) {
      // Exceção: chatgpt é inicializado de forma oculta pelo initializeHiddenChatGPT
      if (name === 'chatgpt') {
        await this.initializeHiddenChatGPT();
      } else {
        return { service: name, loggedInLikely: false, currentUrl: '', backendSessionReady: false, note: `${name === 'flow' ? 'FLOW' : 'Grok'} não iniciado — clique em "Logar"` };
      }
    }
    const page = this.pages[name]!;
    const url = page.url();
    const bodyText = ((await page.textContent('body').catch(() => '')) || '').toLowerCase();

    let loggedInLikely = false;
    let note = 'Não confirmado';

    if (name === 'chatgpt') {
      const count = await page.locator('[contenteditable="true"], textarea').count().catch(() => 0);
      const hasHistory = await page.locator('nav, aside').count().catch(() => 0);
      loggedInLikely = (count > 0 || url.includes('/c/') || url.includes('/g/')) && hasHistory > 0;
      note = loggedInLikely ? 'ChatGPT logado' : 'ChatGPT deslogado';
    } else if (name === 'flow') {
      const hasEditorHint = /novo projeto|new project|criar projeto|imagem|image|vídeo|video|prompt/.test(bodyText);
      loggedInLikely = url.includes('/tools/flow') && hasEditorHint && !/fazer login|entrar|sign in|não é seguro/.test(bodyText);
      note = loggedInLikely ? 'FLOW logado' : 'FLOW deslogado';
    } else if (name === 'grok') {
      const hasEditorHint = /prompt|image|video|chat|textarea|textbox/.test(bodyText);
      loggedInLikely = url.includes('grok') && hasEditorHint && !/sign in|log in|entrar|criar conta/.test(bodyText);
      note = loggedInLikely ? 'Grok logado' : 'Grok deslogado';
    }

    return { service: name, loggedInLikely, currentUrl: url, backendSessionReady: true, note };
  }

  

async flowAutomateSingleScene(settings: {
  prompt: string;
  aspectRatio: string;
  count: number;
  model: string;
}) {
  const { page } = await this.ensureContext('flow', { visible: true, targetUrl: URLS.flow });
  await page.bringToFront().catch(() => {});
  await page.goto(URLS.flow, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(1800);

  const steps: Record<string, string> = {};
  const notes: string[] = [];

  // ── utilidades ────────────────────────────────────────────────────────────
  const safeCount = async (loc: any) => { try { return await loc.count(); } catch { return 0; } };

  const clickFirstVisible = async (locators: any[], settle = 500) => {
    for (const loc of locators) {
      try {
        if (!(await safeCount(loc))) continue;
        const el = loc.first();
        await el.scrollIntoViewIfNeeded().catch(() => {});
        await el.waitFor({ state: 'visible', timeout: 4000 }).catch(() => {});
        await el.click({ timeout: 3000 });
        await page.waitForTimeout(settle);
        return true;
      } catch {}
    }
    return false;
  };

  const getBody = async () => ((await page.textContent('body').catch(() => '')) || '');

  // Encontra o painel (popup) aberto após clicar no chip
  const findPanelBox = async () => {
    const candidates = [
      page.locator('[data-radix-popper-content-wrapper]').first(),
      page.locator('[role="dialog"]').first(),
      page.locator('[role="menu"]').first(),
      page.locator('[role="listbox"]').first(),
    ];
    for (const panel of candidates) {
      try {
        if (!(await safeCount(panel))) continue;
        const box = await panel.boundingBox().catch(() => null);
        if (box && box.width > 120 && box.height > 120) return box;
      } catch {}
    }
    return null;
  };

  // Conta popups abertos (para detectar abertura do menu de modelo)
  const countPopups = async () => ({
    popper: await safeCount(page.locator('[data-radix-popper-content-wrapper]')),
    menu:   await safeCount(page.locator('[role="menu"]')),
    list:   await safeCount(page.locator('[role="listbox"]')),
    dialog: await safeCount(page.locator('[role="dialog"]')),
  });

  // ── Abre compositor (novo projeto se necessário) ───────────────────────────
  const homeText = (await getBody()).toLowerCase();
  if (/novo projeto|new project|criar projeto/.test(homeText)) {
    const opened = await clickFirstVisible([
      page.getByRole('button', { name: /novo projeto|new project|criar projeto/i }),
      page.getByText('Novo projeto', { exact: false }),
      page.getByText('New project', { exact: false }),
    ], 1200);
    steps.newProject = opened ? 'clicked' : 'not-found';
  } else {
    steps.newProject = 'already-open';
  }

  const composerArea = page.locator('xpath=//div[contains(., "O que você quer criar?")]').first();

  // ── 1. Abre chip de configuração ──────────────────────────────────────────
  const chipOpened = await clickFirstVisible([
    composerArea.locator('button').filter({ hasText: /nano banana|imagem 4|x[1-4]|16:9|4:3|1:1|3:4|9:16/i }),
    composerArea.locator('[role="button"]').filter({ hasText: /nano banana|imagem 4|x[1-4]|16:9|4:3|1:1|3:4|9:16/i }),
    page.locator('button').filter({ hasText: /nano banana|imagem 4|x[1-4]|16:9|4:3|1:1|3:4|9:16/i }),
    page.locator('[role="button"]').filter({ hasText: /nano banana|imagem 4|x[1-4]|16:9|4:3|1:1|3:4|9:16/i }),
  ], 1000);
  steps.openChip = chipOpened ? 'ok' : 'not-found';

  await page.waitForTimeout(900);
  let panelBox = await findPanelBox();
  notes.push(`panelBox após chip: ${panelBox ? `${Math.round(panelBox.x)},${Math.round(panelBox.y)} ${Math.round(panelBox.width)}x${Math.round(panelBox.height)}` : 'null'}`);

  // ── 2. Seleciona "Imagem" por coordenada (confirmado funcional) ───────────
  if (panelBox) {
    await page.mouse.click(panelBox.x + 70, panelBox.y + 48);
    await page.waitForTimeout(800);
    steps.mode = 'imagem-coord';
    notes.push(`clicou Imagem: x=${Math.round(panelBox.x + 70)} y=${Math.round(panelBox.y + 48)}`);
  } else {
    // fallback texto
    const ok = await clickFirstVisible([
      page.locator('[role="menu"],[role="listbox"],[data-radix-popper-content-wrapper]').getByText('Imagem', { exact: true }),
      page.getByText('Imagem', { exact: true }),
    ], 800);
    steps.mode = ok ? 'imagem-text' : 'falhou';
  }

  // ── 3. Seleciona proporção por coordenada calibrada ───────────────────────
  if (panelBox) {
    const ratios = ['16:9', '4:3', '1:1', '3:4', '9:16'];
    const aspectIdx = Math.max(0, ratios.indexOf(settings.aspectRatio));
    const leftMargin = panelBox.width * 0.12;
    const usable = panelBox.width * 0.76;
    const gap = usable / 4;
    const ax = panelBox.x + leftMargin + aspectIdx * gap;
    const ay = panelBox.y + panelBox.height * 0.39;
    await page.mouse.click(ax, ay);
    await page.waitForTimeout(800);
    steps.aspect = settings.aspectRatio;
    notes.push(`clicou proporção ${settings.aspectRatio}: x=${Math.round(ax)} y=${Math.round(ay)} idx=${aspectIdx}`);
  } else {
    steps.aspect = 'sem-painel';
  }

  // ── 4. Seleciona quantidade por coordenada calibrada ─────────────────────
  if (panelBox) {
    const countIdx = Math.min(3, Math.max(0, Number(settings.count) - 1));
    const cLeft = panelBox.width * 0.16;
    const cUsable = panelBox.width * 0.68;
    const cGap = cUsable / 3;
    const cx = panelBox.x + cLeft + countIdx * cGap;
    const cy = panelBox.y + panelBox.height * 0.55;
    await page.mouse.click(cx, cy);
    await page.waitForTimeout(800);
    steps.count = `x${settings.count}`;
    notes.push(`clicou quantidade x${settings.count}: x=${Math.round(cx)} y=${Math.round(cy)} idx=${countIdx}`);
  } else {
    steps.count = 'sem-painel';
  }

  // ── 5. Seleciona modelo ───────────────────────────────────────────────────
  // Estratégia: detectar abertura de sub-popup via contagem de popups.
  // O botão do modelo fica na faixa yRatio 0.68–0.88 do painel.
  // Tentamos múltiplas coordenadas até detectar que um popup novo apareceu.

  // Normaliza o nome do modelo alvo
  let targetModelName = 'Nano Banana 2';
  const ml = settings.model.toLowerCase();
  if (ml.includes('pro'))           targetModelName = 'Nano Banana Pro';
  else if (ml.includes('imagem 4')) targetModelName = 'Imagem 4';
  else                              targetModelName = 'Nano Banana 2';

  let modelMenuOpened = false;

  if (panelBox) {
    const beforePopups = await countPopups();
    notes.push(`antes menu modelo: ${JSON.stringify(beforePopups)}`);

    // Coordenadas relativas ao painel onde o botão do modelo costuma estar
    const modelAttempts = [
      { xR: 0.50, yR: 0.79 },
      { xR: 0.78, yR: 0.79 },
      { xR: 0.90, yR: 0.79 },
      { xR: 0.50, yR: 0.86 },
      { xR: 0.83, yR: 0.86 },
      { xR: 0.50, yR: 0.72 },
      { xR: 0.82, yR: 0.72 },
      { xR: 0.25, yR: 0.79 },
      { xR: 0.50, yR: 0.68 },
    ];

    for (const a of modelAttempts) {
      const mx = panelBox.x + panelBox.width  * a.xR;
      const my = panelBox.y + panelBox.height * a.yR;
      await page.mouse.click(mx, my);
      await page.waitForTimeout(900);

      const afterPopups = await countPopups();
      const popupIncreased =
        afterPopups.popper > beforePopups.popper ||
        afterPopups.menu   > beforePopups.menu   ||
        afterPopups.list   > beforePopups.list   ||
        afterPopups.dialog > beforePopups.dialog;

      // Também verifica se o texto do modelo alvo ficou visível no body
      const bodyNow = await getBody();
      const modelVisible =
        bodyNow.includes('Nano Banana Pro') ||
        bodyNow.includes('Nano Banana 2')   ||
        bodyNow.includes('Imagem 4');
      const newModelsAppeared = modelVisible;

      notes.push(`modelo tentativa xR=${a.xR} yR=${a.yR}: popup+=${popupIncreased} modelTexto=${newModelsAppeared}`);

      if (popupIncreased || newModelsAppeared) {
        modelMenuOpened = true;
        steps.openModelMenu = `ok (xR=${a.xR} yR=${a.yR})`;
        break;
      }

      // Se o chip fechou, reabre para continuar tentando
      const chipStillOpen = /16:9|4:3|1:1|3:4|9:16/.test(bodyNow) && /x1|x2|x3|x4/.test(bodyNow);
      if (!chipStillOpen) {
        notes.push('chip fechou; reabrindo...');
        await clickFirstVisible([
          composerArea.locator('button').filter({ hasText: /nano banana|imagem 4|x[1-4]|16:9|4:3|1:1|3:4|9:16/i }),
          page.locator('button').filter({ hasText: /nano banana|imagem 4|x[1-4]|16:9|4:3|1:1|3:4|9:16/i }),
        ], 900);
        panelBox = await findPanelBox() ?? panelBox;
      }
    }
  }

  if (!modelMenuOpened) {
    // Fallback: tenta por texto direto na página (caso o menu já esteja visível)
    modelMenuOpened = await clickFirstVisible([
      page.locator('button').filter({ hasText: /nano banana|imagem 4/i }),
      page.locator('[role="button"]').filter({ hasText: /nano banana|imagem 4/i }),
      page.getByText(/nano banana|imagem 4/i),
    ], 800);
    steps.openModelMenu = modelMenuOpened ? 'ok-text-fallback' : 'falhou';
  }

  // Agora seleciona o modelo no sub-menu aberto
  let selectedModel = '';
  if (modelMenuOpened) {
    // Aguarda o submenu renderizar completamente
    await page.waitForTimeout(900);

    // O submenu é o ÚLTIMO popup aberto.
    // Usa exact:false para ignorar emojis (ex: '🍌 Nano Banana 2' contém 'Nano Banana 2').
    const lastPopper = page.locator('[data-radix-popper-content-wrapper]').last();
    const lastMenu   = page.locator('[role="menu"]').last();

    const modelOk = await clickFirstVisible([
      lastPopper.getByText(targetModelName, { exact: false }),
      lastMenu.getByText(targetModelName, { exact: false }),
      page.locator('[role="listbox"]').last().getByText(targetModelName, { exact: false }),
      page.locator('[role="dialog"]').last().getByText(targetModelName, { exact: false }),
      page.getByRole('option', { name: new RegExp(targetModelName, 'i') }),
      page.getByText(targetModelName, { exact: false }),
    ], 700);

    if (modelOk) {
      selectedModel = targetModelName;
      notes.push('selecao modelo ok por texto: ' + targetModelName);
    } else {
      // Fallback por coordenada no submenu.
      // Ordem dos itens (da screenshot): Nano Banana Pro (0), Nano Banana 2 (1), Imagem 4 (2).
      notes.push('texto falhou; tentando coordenada no submenu');
      try {
        const submenuBox = await lastPopper.boundingBox().catch(() => null)
                        ?? await lastMenu.boundingBox().catch(() => null);
        if (submenuBox) {
          const modelOrder = ['Nano Banana Pro', 'Nano Banana 2', 'Imagem 4'];
          const itemIdx = Math.max(0, modelOrder.indexOf(targetModelName));
          const itemHeight = submenuBox.height / modelOrder.length;
          const sx = submenuBox.x + submenuBox.width * 0.5;
          const sy = submenuBox.y + itemHeight * itemIdx + itemHeight * 0.5;
          await page.mouse.click(sx, sy);
          await page.waitForTimeout(600);
          selectedModel = targetModelName;
          notes.push('selecao modelo ok por coordenada: ' + targetModelName + ' x=' + Math.round(sx) + ' y=' + Math.round(sy) + ' idx=' + itemIdx);
        } else {
          notes.push('submenu box nao encontrado');
        }
      } catch (e) {
        notes.push('falhou coordenada submenu: ' + String(e && e.message || e).slice(0, 100));
      }
    }
  }
  steps.model = selectedModel || (modelMenuOpened ? 'menu-abriu-sem-selecao(' + targetModelName + ')' : 'falhou');

  // Fecha painel clicando fora (garante que o composer fica ativo para digitar)
  if (panelBox) {
    await page.mouse.click(panelBox.x - 30, panelBox.y - 30).catch(() => {});
    await page.waitForTimeout(500);
  }

  // ── 6. Preenche o prompt ──────────────────────────────────────────────────
  let promptFilled = '';
  const promptLocators = [
    composerArea.locator('textarea'),
    composerArea.locator('div[role="textbox"]'),
    composerArea.locator('[contenteditable="true"]'),
    page.locator('textarea').first(),
    page.locator('div[role="textbox"]').first(),
    page.locator('[contenteditable="true"]').first(),
  ];
  for (const loc of promptLocators) {
    try {
      if (!(await safeCount(loc))) continue;
      const el = loc.first();
      await el.click({ timeout: 2500 });
      await page.keyboard.press('Control+A').catch(() => {});
      await page.keyboard.press('Backspace').catch(() => {});
      await page.keyboard.insertText(settings.prompt).catch(async () => {
        await page.keyboard.type(settings.prompt, { delay: 4 });
      });
      await page.waitForTimeout(300);
      promptFilled = 'ok';
      break;
    } catch {}
  }
  steps.prompt = promptFilled;

  // ── 7. Envia (submit) ─────────────────────────────────────────────────────
  let submit = '';
  const submitClicked = await clickFirstVisible([
    page.locator('button[aria-label*="enviar" i], button[aria-label*="send" i], button[aria-label*="generate" i], button[aria-label*="gerar" i]'),
    composerArea.locator('button[type="submit"]'),
    composerArea.locator('button').last(),
  ], 400);
  if (submitClicked) {
    submit = 'button';
  } else {
    try { await page.keyboard.press('Enter'); await page.waitForTimeout(400); submit = 'enter'; } catch {}
  }
  steps.generate = submit;
  steps.notes = notes.join(' | ');

  return {
    ok: Boolean(steps.openChip && steps.mode && steps.aspect && steps.count && selectedModel && steps.prompt && steps.generate),
    steps,
    url: page.url(),
  };
}


}
