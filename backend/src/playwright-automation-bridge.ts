
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
    // ═══════════════════════════════════════════════════════════════════════
    // V5.4.0 - DETECÇÃO DE LOGIN MELHORADA
    // Corrige bugs de status invertido (ChatGPT/Flow/Grok)
    // ═══════════════════════════════════════════════════════════════════════
    
    if (!this.contexts[name] || !this.pages[name] || !(await this.isPageAlive(name))) {
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
      // V5.4.0: Detecção mais robusta - verifica múltiplos sinais
      const hasInputArea = await page.locator('[contenteditable="true"], textarea[placeholder*="Send"], textarea[placeholder*="Enviar"], textarea[placeholder*="Message"]').count().catch(() => 0);
      const hasUserMenu = await page.locator('[data-testid*="user"], button[aria-label*="profile" i], button[aria-haspopup="menu"]').count().catch(() => 0);
      const hasNewChatBtn = await page.locator('a[href="/"], button:has-text("New chat"), button:has-text("Nova conversa")').count().catch(() => 0);
      const hasLoginBtn = /log in|sign up|fazer login|entrar/i.test(bodyText);
      const isLoginPage = url.includes('/auth/login') || url.includes('/auth/signup');
      
      loggedInLikely = !isLoginPage && !hasLoginBtn && (hasInputArea > 0 || hasUserMenu > 0 || hasNewChatBtn > 0);
      note = loggedInLikely ? '✅ ChatGPT logado' : '❌ ChatGPT deslogado';
    } else if (name === 'flow') {
      // V5.4.0: Flow logado tem chip "Imagem"/"Vídeo" + botão "Novo projeto"
      const hasNewProjectBtn = await page.locator('button:has-text("Novo projeto"), button:has-text("New project"), button:has-text("Criar projeto")').count().catch(() => 0);
      const hasChipBtns = await page.locator('button:has-text("Imagem"), button:has-text("Image"), button:has-text("Vídeo"), button:has-text("Video")').count().catch(() => 0);
      const hasUserAvatar = await page.locator('img[alt*="avatar" i], [aria-label*="conta" i], [aria-label*="account" i]').count().catch(() => 0);
      const hasLoginPage = /fazer login|sign in|entrar com google|continue with google/i.test(bodyText);
      
      loggedInLikely = url.includes('labs.google') && !hasLoginPage && (hasNewProjectBtn > 0 || hasChipBtns > 0 || hasUserAvatar > 0);
      note = loggedInLikely ? '✅ FLOW logado' : '❌ FLOW deslogado';
    } else if (name === 'grok') {
      // V5.4.0: Grok logado tem campo de input + botão de envio + sem botão "Sign in"
      const hasInput = await page.locator('textarea, [contenteditable="true"]').count().catch(() => 0);
      const hasSignInBtn = await page.locator('button:has-text("Sign in"), button:has-text("Log in"), a:has-text("Sign in"), a:has-text("Log in")').count().catch(() => 0);
      const hasGoogleSignIn = /sign in with google|continue with google|continuar com google/i.test(bodyText);
      const hasUserMenu = await page.locator('[aria-label*="user" i], [aria-label*="profile" i], img[alt*="avatar" i]').count().catch(() => 0);
      
      loggedInLikely = url.includes('grok') && hasSignInBtn === 0 && !hasGoogleSignIn && (hasInput > 0 || hasUserMenu > 0);
      note = loggedInLikely ? '✅ Grok logado' : '❌ Grok deslogado';
    }

    return { service: name, loggedInLikely, currentUrl: url, backendSessionReady: true, note };
  }
  
  // ═══════════════════════════════════════════════════════════════════════
  // V5.4.0 - NOVAS FUNÇÕES
  // ═══════════════════════════════════════════════════════════════════════
  
  /**
   * V5.5.5 - Captura imagens geradas no Flow + converte blob: para base64
   * Resolve problema de imagens quebradas no frontend
   * + DEDUPLICAÇÃO: mesma imagem aparecendo em múltiplos lugares (galeria + main view)
   */
  async getFlowGeneratedImages() {
    const page = this.pages.flow;
    if (!page) return { ok: false, error: 'Flow não está aberto', images: [] };
    
    try {
      // 1. Primeiro pega METADADOS de todas as imagens (sem o base64 ainda)
      const metaRaw = await page.evaluate(() => {
        const results: Array<{ src: string; naturalWidth: number; naturalHeight: number; rectWidth: number; rectHeight: number; top: number; index: number; alt: string }> = [];
        const imgs = document.querySelectorAll('img');
        let idx = 0;
        
        for (const img of Array.from(imgs)) {
          const src = (img as HTMLImageElement).src;
          const nw = (img as HTMLImageElement).naturalWidth;
          const nh = (img as HTMLImageElement).naturalHeight;
          const rect = img.getBoundingClientRect();
          const alt = (img as HTMLImageElement).alt || '';
          
          if (!src) continue;
          
          // V5.5.7: Filtro CALIBRADO para o Flow real
          // Imagens geradas têm:
          // - alt = "Imagem gerada" / "Generated image" / "Um item de mídia gerado" etc
          // - naturalWidth >= 512 (Flow gera em 768x1376 etc)
          // - URL contém labs.google ou lh3.googleusercontent
          
          const isGeneratedMedia = 
            (alt.toLowerCase().includes('imagem gerada') || 
             alt.toLowerCase().includes('generated image') ||
             alt.toLowerCase().includes('item de mídia gerad') ||
             alt.toLowerCase().includes('media item generated')) ||
            (src.startsWith('blob:') && nw >= 512) ||
            (src.includes('media.getMediaUrlRedirect') && nw >= 512) ||
            ((src.includes('googleusercontent') || src.includes('storage.googleapis')) && nw >= 512);
          
          if (!isGeneratedMedia) continue;
          if (nw < 200 || nh < 200) continue; // descarta avatares/ícones
          
          const top = rect.top + window.scrollY;
          results.push({
            src,
            naturalWidth: nw,
            naturalHeight: nh,
            rectWidth: rect.width,
            rectHeight: rect.height,
            top,
            index: idx++,
            alt
          });
        }
        
        results.sort((a, b) => a.top - b.top);
        return results;
      });
      
      // 2. DEDUPE por src - mesma URL pode aparecer em vários elementos
      const seenSrcs = new Set<string>();
      const meta = metaRaw.filter(m => {
        if (seenSrcs.has(m.src)) return false;
        seenSrcs.add(m.src);
        return true;
      });
      
      // 3. Para cada imagem, converte src (mesmo blob:) em base64
      const images: Array<any> = [];
      for (const m of meta) {
        try {
          const dataUrl = await page.evaluate(async (src: string) => {
            try {
              const response = await fetch(src);
              const blob = await response.blob();
              return await new Promise<string>((resolve, reject) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result as string);
                reader.onerror = () => reject(new Error('FileReader failed'));
                reader.readAsDataURL(blob);
              });
            } catch {
              return '';
            }
          }, m.src);
          
          images.push({
            ...m,
            base64: dataUrl,           // V5.5.5: base64 vai em campo separado
            src: m.src,                // src ORIGINAL (blob:/etc) sempre preservado
            originalSrc: m.src,
            converted: !!dataUrl
          });
        } catch (e) {
          images.push({ ...m, base64: '', originalSrc: m.src, converted: false });
        }
      }
      
      return { ok: true, images, count: images.length };
    } catch (err: any) {
      return { ok: false, error: String(err?.message || err), images: [] };
    }
  }
  
  /**
   * V5.5.3 - Captura progresso de geração no Flow
   * Procura porcentagens, barras de progresso, e textos de status
   */
  async getFlowGenerationProgress() {
    const page = this.pages.flow;
    if (!page) return { ok: false, error: 'Flow não está aberto', progresses: [] };
    
    try {
      const progresses = await page.evaluate(() => {
        const results: Array<{ percent: number; status: string; type: string }> = [];
        
        // 1. Procura textos com porcentagem
        const allElements = document.querySelectorAll('*');
        for (const el of Array.from(allElements)) {
          const text = (el.textContent || '').trim();
          if (text.length > 80) continue; // textos muito longos não são progress
          
          const percentMatch = text.match(/(\d{1,3})\s*%/);
          if (percentMatch) {
            const percent = parseInt(percentMatch[1]);
            if (percent >= 0 && percent <= 100) {
              const rect = el.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) {
                results.push({
                  percent,
                  status: text.substring(0, 40),
                  type: 'text'
                });
              }
            }
          }
        }
        
        // 2. Procura barras de progresso (role=progressbar)
        const progressBars = document.querySelectorAll('[role="progressbar"], progress');
        for (const bar of Array.from(progressBars)) {
          const valueNow = bar.getAttribute('aria-valuenow') || (bar as HTMLProgressElement).value?.toString();
          if (valueNow) {
            const percent = parseInt(valueNow);
            if (!isNaN(percent)) {
              results.push({
                percent,
                status: 'progressbar',
                type: 'progressbar'
              });
            }
          }
        }
        
        // 3. Procura textos de status ("Gerando...", "Generating...")
        const statusTexts = ['Gerando', 'Generating', 'Criando', 'Creating', 'Processing', 'Processando'];
        for (const status of statusTexts) {
          const elements = document.evaluate(
            `//*[contains(text(), '${status}')]`,
            document,
            null,
            XPathResult.UNORDERED_NODE_SNAPSHOT_TYPE,
            null
          );
          for (let i = 0; i < elements.snapshotLength; i++) {
            const el = elements.snapshotItem(i) as Element;
            const text = (el?.textContent || '').trim();
            if (text.length < 60) {
              results.push({ percent: 50, status: text, type: 'status' });
            }
          }
        }
        
        return results;
      });
      
      return { ok: true, progresses, count: progresses.length };
    } catch (err: any) {
      return { ok: false, error: String(err?.message || err), progresses: [] };
    }
  }
  
  /**
   * V5.5.3 - DEBUG: lista TODAS as imagens da página (sem filtro)
   * Útil pra diagnóstico quando getFlowGeneratedImages retorna vazio
   */
  async debugAllFlowImages() {
    const page = this.pages.flow;
    if (!page) return { ok: false, error: 'Flow não está aberto', all: [] };
    
    try {
      const all = await page.evaluate(() => {
        const results: Array<{ src: string; nw: number; nh: number; rw: number; rh: number; alt: string }> = [];
        const imgs = document.querySelectorAll('img');
        for (const img of Array.from(imgs)) {
          const i = img as HTMLImageElement;
          const r = img.getBoundingClientRect();
          results.push({
            src: i.src.substring(0, 100),
            nw: i.naturalWidth,
            nh: i.naturalHeight,
            rw: r.width,
            rh: r.height,
            alt: i.alt || ''
          });
        }
        return results;
      });
      return { ok: true, all, count: all.length };
    } catch (err: any) {
      return { ok: false, error: String(err?.message || err), all: [] };
    }
  }
  
  /**
   * V5.5.0 - Reprovar/Excluir imagem ESPECÍFICA do Flow por URL
   */
  async deleteFlowImageByUrl(imageUrl: string) {
    const page = this.pages.flow;
    if (!page) return { ok: false, error: 'Flow não está aberto' };
    
    try {
      // Encontra a imagem específica pela URL
      const imgLocator = page.locator(`img[src="${imageUrl}"]`).first();
      const count = await imgLocator.count().catch(() => 0);
      
      if (count === 0) {
        return { ok: false, error: 'Imagem não encontrada na página' };
      }
      
      await imgLocator.scrollIntoViewIfNeeded().catch(() => {});
      await page.waitForTimeout(400);
      await imgLocator.hover();
      await page.waitForTimeout(600);
      
      // Procura botão "mais opções" próximo à imagem
      const moreButton = page.locator('button[aria-label*="more" i], button[aria-label*="mais" i], button[aria-haspopup="menu"]:visible').first();
      
      if (await moreButton.count() > 0) {
        await moreButton.click({ force: true });
        await page.waitForTimeout(500);
        
        const deleteOption = page.locator('[role="menuitem"]:has-text("Excluir"), [role="menuitem"]:has-text("Delete"), button:has-text("Excluir"), button:has-text("Delete")').first();
        
        if (await deleteOption.count() > 0) {
          await deleteOption.click();
          await page.waitForTimeout(500);
          
          // Confirma se aparecer modal
          const confirmBtn = page.locator('button:has-text("Confirmar"), button:has-text("Sim"), button:has-text("Confirm"), button:has-text("Yes")').first();
          if (await confirmBtn.count() > 0) {
            await confirmBtn.click();
          }
          
          await page.waitForTimeout(1000);
          return { ok: true, deleted: true };
        }
        // Fecha menu se não achou opção
        await page.keyboard.press('Escape').catch(() => {});
      }
      
      return { ok: false, error: 'Não foi possível encontrar opção de excluir' };
    } catch (err: any) {
      return { ok: false, error: String(err?.message || err) };
    }
  }
  
  /**
   * Reprovar/Excluir uma imagem do Flow (por índice - mantida para compatibilidade)
   */
  async deleteFlowImage(imageIndex: number) {
    const page = this.pages.flow;
    if (!page) return { ok: false, error: 'Flow não está aberto' };
    
    try {
      const images = await page.locator('img[src*="blob:"], img[src*="googleusercontent"]').all();
      
      if (imageIndex >= images.length) {
        return { ok: false, error: `Imagem ${imageIndex} não encontrada (total: ${images.length})` };
      }
      
      const targetImg = images[imageIndex];
      await targetImg.hover();
      await page.waitForTimeout(500);
      
      const moreButton = page.locator('button[aria-label*="more" i], button[aria-label*="mais" i], button:has-text("⋯"), [data-testid*="more"]').first();
      
      if (await moreButton.count() > 0) {
        await moreButton.click();
        await page.waitForTimeout(500);
        
        const deleteOption = page.locator('button:has-text("Excluir"), button:has-text("Delete"), [role="menuitem"]:has-text("Excluir")').first();
        
        if (await deleteOption.count() > 0) {
          await deleteOption.click();
          await page.waitForTimeout(500);
          
          const confirmBtn = page.locator('button:has-text("Confirmar"), button:has-text("Sim"), button:has-text("Confirm")').first();
          if (await confirmBtn.count() > 0) {
            await confirmBtn.click();
          }
          
          await page.waitForTimeout(1000);
          return { ok: true, deleted: imageIndex };
        }
      }
      
      return { ok: false, error: 'Não foi possível encontrar opção de excluir' };
    } catch (err: any) {
      return { ok: false, error: String(err?.message || err) };
    }
  }
  
  /**
   * V5.5.8 - AMPLITUDE pelo método dos 3 PONTINHOS (Incluir no comando)
   * 
   * Conforme as screenshots reais do usuário, o caminho correto é:
   *   hover na imagem → 3 pontinhos (...) → "Incluir no comando" (➕)
   * 
   * Mapeamento posicional descoberto:
   *   - As imagens no Flow estão em ordem temporal (mais antigas no topo, mais novas no final)
   *   - Lendo da direita pra esquerda, de baixo pra cima:
   *     últimas N (perScene) imagens = cena 1
   *     imagens N+1 a 2N = cena 2
   *     etc.
   *   - Equivalente: lendo top-to-bottom em row-major,
   *     imagem da CENA X, VARIANTE V está no índice (totalImages - X*perScene + (V-1))
   * 
   * @param sceneNumbers Array das cenas anteriores cujas IMAGENS APROVADAS devem virar referências
   * @param perScene Quantas imagens por cena (ex: 2)
   * @param approvedVariants Map: { sceneNumber → variant aprovada (1-N) }
   *                         Ex: { 1: 2, 2: 1 } = aprovou variant 2 da cena 1 e variant 1 da cena 2
   */
  async setReferenceImagesByPosition(opts: {
    sceneNumbers: number[];
    perScene: number;
    approvedVariants?: Record<number, number>;
  }) {
    const page = this.pages.flow;
    if (!page) return { ok: false, error: 'Flow não está aberto', notes: [] };
    
    const notes: string[] = [];
    const { sceneNumbers, perScene, approvedVariants = {} } = opts;
    
    try {
      if (!sceneNumbers || sceneNumbers.length === 0) {
        return { ok: true, included: 0, notes: ['Nenhuma cena para referenciar'] };
      }
      
      notes.push(`V5.5.8: refs por POSIÇÃO. cenas=${JSON.stringify(sceneNumbers)} perScene=${perScene}`);
      
      // 0. Limpa referências antigas (clica X no composer)
      try {
        const cleared = await page.evaluate(() => {
          const cancelBtns = Array.from(document.querySelectorAll('button')).filter(b => 
            b.textContent?.trim() === 'cancel'
          );
          const composerCancels = cancelBtns.filter(b => {
            const r = b.getBoundingClientRect();
            return r.top > 700;  // só cancels perto do composer
          });
          composerCancels.forEach(b => (b as HTMLElement).click());
          return composerCancels.length;
        });
        if (cleared > 0) notes.push(`Limpou ${cleared} ref(s) antiga(s)`);
        await page.waitForTimeout(500);
      } catch {}
      
      // 1. Coleta TODAS as imagens geradas da página principal, ordenadas por posição
      // V5.5.9 - Filtro CONSISTENTE com /flow-images: aceita URL OU alt
      const allImages = await page.evaluate(() => {
        const imgs = Array.from(document.querySelectorAll('img'));
        const generated = imgs
          .filter(i => {
            const alt = ((i as HTMLImageElement).alt || '').toLowerCase();
            const src = (i as HTMLImageElement).src || '';
            const nw = (i as HTMLImageElement).naturalWidth;
            const r = i.getBoundingClientRect();
            
            // V5.5.9: aceita imagens reconhecidas pelo URL OU pelo alt
            const altMatches = alt.includes('gerada') || alt.includes('generated') 
                            || alt.includes('item de mídia gerad') || alt.includes('media item generated');
            const urlMatches = src.includes('media.getMediaUrlRedirect') 
                            || src.startsWith('blob:') 
                            || (src.includes('googleusercontent') && nw >= 512);
            
            return (altMatches || urlMatches)
                && nw >= 512        // descartam ícones/avatares
                && r.width >= 60    // visível
                && r.height >= 60
                && r.top >= -100    // na viewport (com tolerância)
                && r.left >= -50;
          })
          .map((i, idx) => {
            const r = i.getBoundingClientRect();
            return {
              idx,
              src: (i as HTMLImageElement).src,
              alt: (i as HTMLImageElement).alt,
              x: r.left, y: r.top,
              w: r.width, h: r.height,
              centerX: r.left + r.width / 2,
              centerY: r.top + r.height / 2,
            };
          });
        
        // Ordena por: row (top), depois column (left). Top-to-bottom, left-to-right.
        generated.sort((a, b) => {
          if (Math.abs(a.y - b.y) < 20) return a.x - b.x;
          return a.y - b.y;
        });
        
        return generated;
      });
      
      const totalImages = allImages.length;
      notes.push(`Detectadas ${totalImages} imagens na grade do Flow`);
      
      if (totalImages === 0) {
        return { ok: false, error: 'Nenhuma imagem detectada na grade', notes };
      }
      
      // 2. Para cada cena de referência, calcula posições das imagens
      // Lógica: se eu setei perScene=2 imagens por cena no DarkPlanner,
      // a CENA MAIS ANTIGA (cena 1) está nas posições mais ANTIGAS = primeiras na ordenação top-left.
      // A CENA MAIS NOVA está nas últimas posições.
      //
      // Cena 1 → índices [0, 1, ..., perScene-1]
      // Cena 2 → índices [perScene, perScene+1, ..., 2*perScene-1]
      // Cena N → índices [(N-1)*perScene, ..., N*perScene-1]
      
      let included = 0;
      
      for (const sceneNum of sceneNumbers) {
        // Variante específica aprovada, ou padrão = todas as variantes daquela cena
        const variantsToUse: number[] = [];
        if (approvedVariants[sceneNum]) {
          variantsToUse.push(approvedVariants[sceneNum]);
        } else {
          // Sem aprovação específica: usa só a primeira variante (variant 1)
          variantsToUse.push(1);
        }
        
        for (const variant of variantsToUse) {
          const targetIdx = (sceneNum - 1) * perScene + (variant - 1);
          
          if (targetIdx < 0 || targetIdx >= totalImages) {
            notes.push(`[cena ${sceneNum} v${variant}] idx ${targetIdx} fora de [0, ${totalImages-1}]`);
            continue;
          }
          
          const target = allImages[targetIdx];
          notes.push(`[cena ${sceneNum} v${variant}] idx=${targetIdx} pos=(${Math.round(target.centerX)},${Math.round(target.centerY)})`);
          
          // 3. Hover na imagem → aparecem botões (favoritar, reutilizar, ⋯)
          try {
            // V5.5.9 - HOVER ROBUSTO (3 estratégias)
            // Estratégia 1: mouse.move (Playwright)
            await page.mouse.move(target.centerX - 100, target.centerY);
            await page.waitForTimeout(200);
            await page.mouse.move(target.centerX, target.centerY);
            await page.waitForTimeout(500);
            
            // Estratégia 2: dispatch mouseenter/mouseover real no DOM
            await page.evaluate((info) => {
              const el = document.elementFromPoint(info.centerX, info.centerY);
              if (!el) return;
              // Dispatch eventos de hover REAIS
              const events = ['mouseenter', 'mouseover', 'pointerenter', 'pointerover', 'mousemove'];
              for (const ev of events) {
                el.dispatchEvent(new MouseEvent(ev, {
                  bubbles: true, cancelable: true,
                  clientX: info.centerX, clientY: info.centerY,
                  view: window
                }));
              }
              // Aplica em parents também (Flow pode escutar em wrappers)
              let parent = el.parentElement;
              for (let i = 0; i < 5 && parent; i++) {
                for (const ev of events) {
                  parent.dispatchEvent(new MouseEvent(ev, {
                    bubbles: true, cancelable: true,
                    clientX: info.centerX, clientY: info.centerY,
                  }));
                }
                parent = parent.parentElement;
              }
            }, { centerX: target.centerX, centerY: target.centerY });
            
            await page.waitForTimeout(800);
            
            // 4. V5.5.9 - DEBUG: lista TODOS os botões visíveis perto da imagem
            const buttonsNearImage = await page.evaluate((info) => {
              const allBtns = Array.from(document.querySelectorAll('button'));
              return allBtns
                .filter(b => {
                  const r = b.getBoundingClientRect();
                  if (r.width === 0 || r.height === 0) return false;
                  const dist = Math.hypot(
                    r.left + r.width/2 - info.centerX,
                    r.top + r.height/2 - info.centerY
                  );
                  return dist < 250;
                })
                .map(b => {
                  const r = b.getBoundingClientRect();
                  return {
                    text: (b.textContent || '').trim().slice(0, 40),
                    aria: (b.getAttribute('aria-label') || '').slice(0, 30),
                    x: Math.round(r.left), y: Math.round(r.top),
                    w: Math.round(r.width), h: Math.round(r.height),
                    distance: Math.round(Math.hypot(
                      r.left + r.width/2 - info.centerX,
                      r.top + r.height/2 - info.centerY
                    )),
                  };
                })
                .sort((a, b) => a.distance - b.distance)
                .slice(0, 8);
            }, { centerX: target.centerX, centerY: target.centerY });
            
            notes.push(`[cena ${sceneNum}] btns próximos: ${buttonsNearImage.map(b => `"${b.text}"@${b.distance}px`).join(', ')}`);
            
            // 5. Procura o botão de 3 pontinhos com matching FLEXÍVEL
            const moreClicked = await page.evaluate((info) => {
              const allBtns = Array.from(document.querySelectorAll('button'));
              
              // V5.5.9: matching flexível (texto OU aria-label)
              const moreBtns = allBtns.filter(b => {
                const t = (b.textContent || '').trim().toLowerCase();
                const a = (b.getAttribute('aria-label') || '').toLowerCase();
                const combined = t + ' ' + a;
                return /more_vert|more_horiz|mais opç|more options|⋯|\.\.\./i.test(combined);
              });
              
              if (moreBtns.length === 0) return { ok: false, count: 0, reason: 'no-more-buttons' };
              
              moreBtns.sort((a, b) => {
                const ra = a.getBoundingClientRect();
                const rb = b.getBoundingClientRect();
                const da = Math.hypot(ra.left + ra.width/2 - info.centerX, ra.top + ra.height/2 - info.centerY);
                const db = Math.hypot(rb.left + rb.width/2 - info.centerX, rb.top + rb.height/2 - info.centerY);
                return da - db;
              });
              
              const closest = moreBtns[0] as HTMLElement;
              const r = closest.getBoundingClientRect();
              const distance = Math.hypot(r.left + r.width/2 - info.centerX, r.top + r.height/2 - info.centerY);
              
              if (distance > 250) return { ok: false, count: moreBtns.length, distance: Math.round(distance), reason: 'too-far' };
              
              // V5.5.9: Click triplo (click, mousedown+mouseup, dispatchEvent)
              try {
                closest.click();
              } catch {}
              try {
                closest.dispatchEvent(new MouseEvent('mousedown', {bubbles: true, cancelable: true}));
                closest.dispatchEvent(new MouseEvent('mouseup', {bubbles: true, cancelable: true}));
                closest.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}));
              } catch {}
              
              return { ok: true, count: moreBtns.length, distance: Math.round(distance), clickedText: (closest.textContent || '').slice(0, 30) };
            }, { centerX: target.centerX, centerY: target.centerY });
            
            if (!moreClicked.ok) {
              notes.push(`[cena ${sceneNum}] more_vert FALHOU: ${moreClicked.reason} count=${moreClicked.count} dist=${moreClicked.distance || '?'}`);
              continue;
            }
            
            notes.push(`[cena ${sceneNum}] more_vert OK (texto="${moreClicked.clickedText}" dist=${moreClicked.distance}px)`);
            await page.waitForTimeout(1000); // menu precisa abrir totalmente
            
            // 6. V5.5.9 - DEBUG: lista o que apareceu no menu
            const menuItems = await page.evaluate(() => {
              // Pega menus / popups visíveis
              const popups = Array.from(document.querySelectorAll(
                '[role="menu"], [role="dialog"], [data-radix-popper-content-wrapper], [role="listbox"]'
              )).filter(el => {
                const r = el.getBoundingClientRect();
                return r.width > 0 && r.height > 0;
              });
              
              if (popups.length === 0) return { items: [], popupsCount: 0 };
              
              // Pega o último popup aberto (mais recente)
              const lastPopup = popups[popups.length - 1];
              const items = Array.from(lastPopup.querySelectorAll('button, [role="menuitem"], li, a'))
                .filter(el => {
                  const r = el.getBoundingClientRect();
                  return r.width > 0 && r.height > 0;
                })
                .map(el => ({
                  text: (el.textContent || '').trim().slice(0, 50),
                  tag: el.tagName,
                  role: el.getAttribute('role') || '',
                }))
                .slice(0, 15);
              
              return { items, popupsCount: popups.length };
            });
            
            notes.push(`[cena ${sceneNum}] menu tem ${menuItems.items.length} itens (popups=${menuItems.popupsCount}): ${menuItems.items.slice(0, 5).map(i => `"${i.text}"`).join(', ')}`);
            
            // 7. Clica em "Incluir no comando" com matching flexível
            const includeClicked = await page.evaluate(() => {
              const all = Array.from(document.querySelectorAll('button, [role="menuitem"], li, a, div, span'));
              
              // V5.5.9: matching MUITO flexível
              const target = all.find(el => {
                const t = (el.textContent || '').trim().toLowerCase();
                if (t.length > 80) return false; // ignora textos muito longos
                // Aceita várias variações
                return /incluir.*comando|include.*prompt/i.test(t) ||
                       t === 'incluir no comando' ||
                       t.replace(/[^\w\s]/g, '').trim() === 'incluir no comando' ||
                       t.replace(/[^\w\s]/g, '').trim() === 'add_2incluir no comando';
              });
              
              if (!target) {
                // Debug: lista TUDO que tem palavra "incluir"
                const incluirElements = all
                  .filter(el => {
                    const t = (el.textContent || '').trim().toLowerCase();
                    return t.includes('incluir') && t.length < 100;
                  })
                  .slice(0, 5)
                  .map(el => (el.textContent || '').trim().slice(0, 50));
                return { ok: false, reason: 'incluir-not-found', similar: incluirElements };
              }
              
              const targetEl = target as HTMLElement;
              try { targetEl.click(); } catch {}
              try {
                targetEl.dispatchEvent(new MouseEvent('mousedown', {bubbles: true, cancelable: true}));
                targetEl.dispatchEvent(new MouseEvent('mouseup', {bubbles: true, cancelable: true}));
                targetEl.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}));
              } catch {}
              return { ok: true, text: (target.textContent || '').slice(0, 50) };
            });
            
            if (!includeClicked.ok) {
              const similar = includeClicked.similar?.length 
                ? ` (similares: ${includeClicked.similar.map((s: string) => `"${s}"`).join(', ')})`
                : '';
              notes.push(`[cena ${sceneNum}] "Incluir" NÃO encontrado${similar}`);
              await page.keyboard.press('Escape').catch(() => {});
              continue;
            }
            
            included++;
            notes.push(`[cena ${sceneNum}] ✅ "Incluir" clicado: "${includeClicked.text}"`);
            await page.waitForTimeout(900);
          } catch (e) {
            notes.push(`[cena ${sceneNum}] EXCEPTION: ${String(e).slice(0, 80)}`);
            await page.keyboard.press('Escape').catch(() => {});
          }
        }
      }
      
      // 6. Verifica quantas refs foram adicionadas no composer
      const refsInComposer = await page.evaluate(() => {
        const cancelBtns = Array.from(document.querySelectorAll('button')).filter(b => 
          b.textContent?.trim() === 'cancel'
        );
        return cancelBtns.filter(b => {
          const r = b.getBoundingClientRect();
          return r.top > 700;
        }).length;
      });
      
      notes.push(`Composer agora tem ${refsInComposer} ref(s)`);
      
      return { 
        ok: included > 0, 
        included: refsInComposer,
        attempted: sceneNumbers.length,
        notes, 
        method: 'three-dots-incluir-no-comando' 
      };
    } catch (err: any) {
      try { await page.keyboard.press('Escape'); } catch {}
      return { ok: false, error: String(err?.message || err), notes };
    }
  }
  
  /**
   * V5.5.8 - Wrapper de compatibilidade: aceita URLs aprovadas (modo antigo)
   * Internamente delega para setReferenceImagesByPosition se receber metadata adicional
   */
  async setReferenceImagesByUrls(approvedOriginalSrcs: string[]) {
    // Mantido para compatibilidade. Recomenda-se usar setReferenceImagesByPosition.
    return { 
      ok: false, 
      included: 0, 
      notes: ['V5.5.8: use setReferenceImagesByPosition em vez disso (passa sceneNumbers + perScene)'],
      method: 'deprecated'
    };
  }

  /**
   * V5.5.4 - Estratégia alternativa: hover na imagem + 3 pontinhos + "Incluir no comando"
   */
  async setReferencesByHover(approvedOriginalSrcs: string[]) {
    const page = this.pages.flow;
    if (!page) return { ok: false, error: 'Flow não está aberto', notes: [] };
    
    const notes: string[] = ['Tentando estratégia alternativa: hover + 3 pontinhos'];
    let included = 0;
    
    try {
      for (const targetSrc of approvedOriginalSrcs) {
        try {
          const imgLocator = page.locator(`img[src="${targetSrc}"]`).first();
          if (await imgLocator.count() === 0) {
            notes.push(`Imagem não está mais na página (deletada?): ${targetSrc.slice(0, 30)}...`);
            continue;
          }
          
          await imgLocator.scrollIntoViewIfNeeded().catch(() => {});
          await page.waitForTimeout(500);
          await imgLocator.hover();
          await page.waitForTimeout(700);
          
          // Procura botão de "mais opções" perto da imagem
          const moreBtn = page.locator('button[aria-label*="more" i]:visible, button[aria-label*="mais" i]:visible, button[aria-haspopup="menu"]:visible').last();
          
          if (await moreBtn.count() > 0) {
            await moreBtn.click({ force: true });
            await page.waitForTimeout(600);
            
            const includeBtn = page.locator('[role="menuitem"]:has-text("Incluir"):visible, button:has-text("Incluir no comando"):visible').first();
            if (await includeBtn.count() > 0) {
              await includeBtn.click();
              included++;
              notes.push(`✅ Imagem incluída via hover`);
              await page.waitForTimeout(400);
            } else {
              await page.keyboard.press('Escape').catch(() => {});
              notes.push('Menu abriu mas sem opção "Incluir"');
            }
          } else {
            notes.push('Botão "..." não apareceu no hover');
          }
        } catch (e) {
          notes.push(`Erro hover: ${String(e).slice(0, 60)}`);
        }
      }
    } catch (err: any) {
      return { ok: false, error: String(err?.message || err), notes };
    }
    
    return { ok: included > 0, included, notes, method: 'hover' };
  }
  
  /**
   * V5.5.0 - Mantida para compatibilidade
   * AMPLITUDE: Adiciona imagens das cenas anteriores como referência no Flow
   */
  async setReferenceImages(sceneNumbers: number[]) {
    const page = this.pages.flow;
    if (!page) return { ok: false, error: 'Flow não está aberto' };
    
    const notes: string[] = [];
    
    try {
      // ESTRATÉGIA 1: Procurar pelo botão "+" no campo de prompt
      const plusButton = page.locator('button[aria-label*="adicionar" i], button[aria-label*="add" i], button:has-text("+"), [data-testid*="add"]').first();
      
      if (await plusButton.count() > 0) {
        await plusButton.click();
        await page.waitForTimeout(700);
        notes.push('Botão + clicado');
        
        const imageOptions = await page.locator('[role="dialog"] img, [role="menu"] img, .popup img').all();
        
        let selected = 0;
        for (let i = 0; i < imageOptions.length && selected < sceneNumbers.length; i++) {
          try {
            await imageOptions[i].click();
            await page.waitForTimeout(300);
            selected++;
          } catch {}
        }
        
        notes.push(`${selected} imagens selecionadas`);
        
        const confirmBtn = page.locator('button:has-text("Adicionar"), button:has-text("Confirmar"), button:has-text("OK")').first();
        if (await confirmBtn.count() > 0) {
          await confirmBtn.click();
          notes.push('Adicionadas como referência');
        }
        
        return { ok: true, method: 'plus-button', selected, notes };
      }
      
      return { ok: false, error: 'Botão + não encontrado', notes };
    } catch (err: any) {
      return { ok: false, error: String(err?.message || err), notes };
    }
  }
  
  /**
   * V5.6.0 - AMPLITUDE: Adiciona TODAS as imagens do projeto como referência
   * 
   * Fluxo descoberto via DOM ao vivo:
   *   1. Clica "+" (textContent === "add_2Criar") → abre dialog
   *   2. Dialog tem lista de "gerações" (cenas) na esquerda
   *   3. Clicar numa geração ADICIONA automaticamente como referência e FECHA o dialog
   *   4. Para múltiplas refs: abre "+" de novo, clica próxima geração, etc
   * 
   * Como as imagens reprovadas já foram deletadas do Flow,
   * TODAS as gerações restantes no dialog são de imagens aprovadas.
   */
  async addAllAsReferences() {
    const page = this.pages.flow;
    if (!page) return { ok: false, error: 'Flow não está aberto', notes: [] };
    
    const notes: string[] = [];
    let included = 0;
    
    try {
      // 1. Descobrir quantas gerações/cenas existem no dialog
      // Abre "+" primeiro pra contar
      const plusClicked = await page.evaluate(() => {
        const plus = Array.from(document.querySelectorAll('button')).find(b => 
          (b.textContent || '').trim() === 'add_2Criar' || (b.textContent || '').trim() === 'add_2'
        );
        if (plus) { (plus as HTMLElement).click(); return true; }
        return false;
      });
      
      if (!plusClicked) {
        notes.push('Botão "+" (add_2Criar) não encontrado');
        return { ok: false, error: 'Botão + não encontrado', notes };
      }
      
      await page.waitForTimeout(1500);
      
      // Verifica se dialog abriu
      const dialogInfo = await page.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"]');
        if (!dialog) return null;
        
        // Conta itens de geração na lista lateral (DIVs com img, ~56px de altura)
        const allDivs = Array.from(dialog.querySelectorAll('div'));
        const sceneItems = allDivs.filter(d => {
          const r = d.getBoundingClientRect();
          return r.width >= 200 && r.width <= 300 
              && r.height >= 40 && r.height <= 80 
              && d.querySelector('img');
        });
        
        // Dedupe por posição Y
        const seen = new Set<number>();
        const unique: Array<{y: number; centerX: number; centerY: number; text: string}> = [];
        for (const s of sceneItems) {
          const r = s.getBoundingClientRect();
          const key = Math.round(r.top);
          if (!seen.has(key)) {
            seen.add(key);
            unique.push({
              y: r.top,
              centerX: r.left + r.width / 2,
              centerY: r.top + r.height / 2,
              text: (s.textContent || '').trim().slice(0, 40),
            });
          }
        }
        
        // Ordena por Y (topo = mais recente, baixo = mais antigo)
        unique.sort((a, b) => a.y - b.y);
        
        return { count: unique.length, items: unique };
      });
      
      if (!dialogInfo) {
        notes.push('Dialog não abriu após clicar "+"');
        return { ok: false, error: 'Dialog não abriu', notes };
      }
      
      notes.push(`Dialog tem ${dialogInfo.count} geração(ões)`);
      
      if (dialogInfo.count === 0) {
        await page.keyboard.press('Escape').catch(() => {});
        return { ok: false, error: 'Dialog vazio', notes };
      }
      
      // 2. Clica em cada geração (da mais antiga pra mais recente)
      // Cada clique fecha o dialog, então preciso reabrir "+" entre cada um
      const totalItems = dialogInfo.count;
      
      for (let i = totalItems - 1; i >= 0; i--) {
        // Se não é o primeiro, precisa reabrir o "+"
        if (included > 0) {
          const reopened = await page.evaluate(() => {
            const plus = Array.from(document.querySelectorAll('button')).find(b => 
              (b.textContent || '').trim() === 'add_2Criar' || (b.textContent || '').trim() === 'add_2'
            );
            if (plus) { (plus as HTMLElement).click(); return true; }
            return false;
          });
          if (!reopened) {
            notes.push(`Falha ao reabrir "+" para item ${i}`);
            break;
          }
          await page.waitForTimeout(1200);
        }
        
        // Clica no item i do dialog (por coordenada, já que sei as posições)
        const clicked = await page.evaluate((idx) => {
          const dialog = document.querySelector('[role="dialog"]');
          if (!dialog) return { ok: false, reason: 'no-dialog' };
          
          const allDivs = Array.from(dialog.querySelectorAll('div'));
          const sceneItems = allDivs.filter(d => {
            const r = d.getBoundingClientRect();
            return r.width >= 200 && r.width <= 300 
                && r.height >= 40 && r.height <= 80 
                && d.querySelector('img');
          });
          
          // Dedupe
          const seen = new Set<number>();
          const unique: HTMLElement[] = [];
          for (const s of sceneItems) {
            const r = s.getBoundingClientRect();
            const key = Math.round(r.top);
            if (!seen.has(key)) {
              seen.add(key);
              unique.push(s as HTMLElement);
            }
          }
          unique.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
          
          if (idx >= unique.length) return { ok: false, reason: `idx ${idx} >= ${unique.length}` };
          
          const target = unique[idx];
          const text = (target.textContent || '').trim().slice(0, 30);
          target.click();
          return { ok: true, text };
        }, i);
        
        if (clicked.ok) {
          included++;
          notes.push(`[${i}] ✅ ref adicionada: "${clicked.text}"`);
        } else {
          notes.push(`[${i}] falha: ${clicked.reason}`);
        }
        
        await page.waitForTimeout(800);
      }
      
      // 3. Verifica quantas refs no composer
      const refsInComposer = await page.evaluate(() => {
        const cancelBtns = Array.from(document.querySelectorAll('button')).filter(b => 
          (b.textContent || '').trim() === 'cancel'
        );
        return cancelBtns.filter(b => {
          const r = b.getBoundingClientRect();
          return r.top > 700;
        }).length;
      });
      
      notes.push(`Composer tem ${refsInComposer} ref(s)`);
      
      return { ok: included > 0, included: refsInComposer, notes, method: 'add-all-v560' };
    } catch (err: any) {
      try { await page.keyboard.press('Escape'); } catch {}
      return { ok: false, error: String(err?.message || err), notes };
    }
  }

  /**
   * Aprovar imagem - apenas marca como aprovada (não faz nada no Flow)
   */
  async approveImage(imageIndex: number, sceneNumber: number) {
    return { ok: true, approved: true, imageIndex, sceneNumber, timestamp: new Date().toISOString() };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // V5.6.0 - SISTEMA DE REFERÊNCIAS POR DOWNLOAD + UPLOAD
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Cria pasta do projeto para salvar imagens
   * Retorna o caminho criado
   */
  async createProjectDir(basePath: string, projectName?: string) {
    const name = projectName || `video_${Date.now()}`;
    const rootBase = basePath || path.resolve(process.cwd(), '..');
    const projectDir = path.join(rootBase, 'projetos', name);
    const imgDir = path.join(projectDir, 'imagens');
    const vidDir = path.join(projectDir, 'videos');
    
    fs.mkdirSync(imgDir, { recursive: true });
    fs.mkdirSync(vidDir, { recursive: true });
    
    return { ok: true, projectDir, imgDir, vidDir, name };
  }

  /**
   * Salva uma imagem (base64 ou URL do Flow) no disco
   * @param base64Data string data:image/png;base64,... OU URL pra buscar do Flow
   * @param fileName ex: "cena_01_v1.png"
   * @param saveDir pasta destino
   */
  async saveImageToDisk(base64Data: string, fileName: string, saveDir: string) {
    try {
      fs.mkdirSync(saveDir, { recursive: true });
      const filePath = path.join(saveDir, fileName);
      
      let buffer: Buffer;
      
      if (base64Data.startsWith('data:image')) {
        // Já é base64 — extrai os bytes
        const base64Content = base64Data.split(',')[1];
        buffer = Buffer.from(base64Content, 'base64');
      } else if (base64Data.startsWith('http')) {
        // É URL — precisa buscar do contexto do Flow via Playwright
        const page = this.pages.flow;
        if (!page) return { ok: false, error: 'Flow não está aberto' };
        
        const b64 = await page.evaluate(async (url: string) => {
          try {
            const resp = await fetch(url);
            const blob = await resp.blob();
            return await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onloadend = () => resolve(reader.result as string);
              reader.onerror = reject;
              reader.readAsDataURL(blob);
            });
          } catch { return ''; }
        }, base64Data);
        
        if (!b64) return { ok: false, error: 'Falha ao baixar imagem do Flow' };
        
        const content = b64.split(',')[1];
        buffer = Buffer.from(content, 'base64');
      } else {
        return { ok: false, error: 'Formato não reconhecido (nem base64 nem URL)' };
      }
      
      fs.writeFileSync(filePath, buffer);
      
      return { 
        ok: true, 
        filePath, 
        fileName,
        sizeKB: Math.round(buffer.length / 1024)
      };
    } catch (err: any) {
      return { ok: false, error: String(err?.message || err) };
    }
  }

  /**
   * V5.6.0 - Upload de imagem local como referência no Flow
   * 
   * Fluxo descoberto via inspeção DOM ao vivo:
   *   1. Clica "+" (textContent === "add_2Criar") → abre dialog
   *   2. Dialog tem "Faça upload de uma imagem" com input[type="file"]
   *   3. Playwright usa setInputFiles() pra enviar o arquivo
   *   4. Dialog fecha, imagem aparece como thumb de referência no composer
   */
  async uploadImageAsReference(filePath: string) {
    const page = this.pages.flow;
    if (!page) return { ok: false, error: 'Flow não está aberto', notes: [] };
    
    const notes: string[] = [];
    
    try {
      // Verifica se o arquivo existe
      if (!fs.existsSync(filePath)) {
        return { ok: false, error: `Arquivo não existe: ${filePath}`, notes };
      }
      
      notes.push(`Arquivo: ${path.basename(filePath)} (${Math.round(fs.statSync(filePath).size / 1024)}KB)`);
      
      // 1. Clica no botão "+" (add_2Criar)
      const plusClicked = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const plus = btns.find(b => {
          const t = (b.textContent || '').trim();
          return t === 'add_2Criar' || t === 'add_2';
        });
        if (plus) { (plus as HTMLElement).click(); return true; }
        return false;
      });
      
      if (!plusClicked) {
        notes.push('Botão "+" (add_2Criar) não encontrado; tentando seletores genéricos');
        const genericPlus = [
          page.locator('button[aria-label*="Add" i]').first(),
          page.locator('button[aria-label*="Adicionar" i]').first(),
          page.locator('button').filter({ hasText: /^\+$/ }).first(),
          page.locator('[role="button"]').filter({ hasText: /^\+$/ }).first(),
          page.getByText('+', { exact:true }).first(),
        ];
        for (const loc of genericPlus) {
          try {
            const count = await loc.count();
            notes.push(`generic plus count=${count}`);
            if (!count) continue;
            await loc.click({ timeout: 2500 });
            await page.waitForTimeout(1200);
            if (await page.locator('[role="dialog"], input[type="file"]').count().catch(() => 0)) {
              notes.push('Botão + genérico clicado');
              break;
            }
          } catch (e:any) {
            notes.push(`plus genérico falhou: ${String(e?.message || e).slice(0,120)}`);
          }
        }
      } else {
        notes.push('Botão "+" clicado');
        await page.waitForTimeout(1500);
      }
      
      // 2. Verifica se dialog abriu
      const dialogOpen = await page.evaluate(() => !!document.querySelector('[role="dialog"]'));
      if (!dialogOpen) {
        notes.push('Dialog não abriu após clicar "+"');
        return { ok: false, error: 'Dialog não abriu', notes };
      }
      
      notes.push('Dialog abriu');
      
      // 3. Procura input[type="file"] dentro do dialog (pode estar hidden)
      // O Flow tem "Faça upload de uma imagem" que provavelmente tem um input file
      
      // Estratégia A: input[type="file"] direto no dialog
      let fileInput = page.locator('[role="dialog"] input[type="file"]');
      let inputCount = await fileInput.count();
      
      if (inputCount === 0) {
        // Estratégia B: input[type="file"] em QUALQUER lugar da página
        fileInput = page.locator('input[type="file"]');
        inputCount = await fileInput.count();
        notes.push(`input[type="file"] global: ${inputCount} encontrado(s)`);
      } else {
        notes.push(`input[type="file"] no dialog: ${inputCount} encontrado(s)`);
      }
      
      if (inputCount === 0) {
        // Estratégia C: Clica no texto "Faça upload" pra revelar o input
        const uploadTextClicked = await page.evaluate(() => {
          const all = Array.from(document.querySelectorAll('*'));
          const target = all.find(el => {
            const t = (el.textContent || '').trim().toLowerCase();
            return (t.includes('upload') || t.includes('enviar')) && t.length < 60;
          });
          if (target) { (target as HTMLElement).click(); return true; }
          return false;
        });
        
        if (uploadTextClicked) {
          notes.push('Clicou em texto "upload"');
          await page.waitForTimeout(800);
          fileInput = page.locator('input[type="file"]');
          inputCount = await fileInput.count();
          notes.push(`input[type="file"] após click upload: ${inputCount}`);
        }
      }
      
      if (inputCount === 0) {
        // Última tentativa: procura qualquer input que aceite arquivo
        fileInput = page.locator('input[accept*="image"]');
        inputCount = await fileInput.count();
        notes.push(`input[accept=image]: ${inputCount}`);
      }
      
      if (inputCount === 0) {
        await page.keyboard.press('Escape').catch(() => {});
        notes.push('NENHUM input[type="file"] encontrado!');
        
        // Debug: lista todos os inputs da página
        const allInputs = await page.evaluate(() => {
          return Array.from(document.querySelectorAll('input')).map(i => ({
            type: i.type,
            accept: i.accept,
            name: i.name,
            id: i.id,
            hidden: i.hidden || getComputedStyle(i).display === 'none',
          }));
        });
        notes.push(`Debug inputs: ${JSON.stringify(allInputs).slice(0, 200)}`);
        
        return { ok: false, error: 'input[type="file"] não encontrado', notes };
      }
      
      // 4. Faz upload via setInputFiles
      notes.push(`Fazendo upload via setInputFiles...`);
      await fileInput.first().setInputFiles(filePath);
      
      await page.waitForTimeout(2000);
      
      // 5. Verifica se a referência apareceu no composer
      const refsInComposer = await page.evaluate(() => {
        const cancelBtns = Array.from(document.querySelectorAll('button')).filter(b => 
          (b.textContent || '').trim() === 'cancel'
        );
        return cancelBtns.filter(b => {
          const r = b.getBoundingClientRect();
          return r.top > 700;
        }).length;
      });
      
      // Fecha dialog se ainda estiver aberto
      const stillOpen = await page.evaluate(() => !!document.querySelector('[role="dialog"]'));
      if (stillOpen) {
        await page.keyboard.press('Escape').catch(() => {});
        notes.push('Dialog fechado via Escape');
      }
      
      notes.push(`Composer tem ${refsInComposer} referência(s)`);
      
      return { 
        ok: refsInComposer > 0, 
        included: refsInComposer, 
        filePath,
        notes, 
        method: 'upload-file' 
      };
    } catch (err: any) {
      try { await page.keyboard.press('Escape'); } catch {}
      return { ok: false, error: String(err?.message || err), notes };
    }
  }

  /**
   * V5.6.0 - Deleta TODAS as imagens do Flow EXCETO as dos índices informados
   * @param keepIndices Índices das imagens a manter (0-based, na ordem top-to-bottom)
   */
  async deleteFlowImagesExcept(keepIndices: number[]) {
    const page = this.pages.flow;
    if (!page) return { ok: false, error: 'Flow não está aberto', notes: [] };
    
    const notes: string[] = [];
    
    try {
      // Pega todas as imagens geradas
      const allImages = await page.evaluate(() => {
        const imgs = Array.from(document.querySelectorAll('img'));
        return imgs
          .filter(i => {
            const src = (i as HTMLImageElement).src;
            const nw = (i as HTMLImageElement).naturalWidth;
            return nw >= 512 && (
              src.includes('media.getMediaUrlRedirect') ||
              src.startsWith('blob:') ||
              src.includes('googleusercontent')
            );
          })
          .map((i, idx) => {
            const r = i.getBoundingClientRect();
            return {
              idx,
              src: (i as HTMLImageElement).src,
              centerX: r.left + r.width / 2,
              centerY: r.top + r.height / 2,
            };
          });
      });
      
      notes.push(`Total imagens no Flow: ${allImages.length}`);
      notes.push(`Mantendo índices: [${keepIndices.join(', ')}]`);
      
      let deleted = 0;
      
      // Deleta as que NÃO estão em keepIndices (de trás pra frente pra não mudar índices)
      for (let i = allImages.length - 1; i >= 0; i--) {
        if (keepIndices.includes(i)) continue;
        
        const img = allImages[i];
        
        try {
          // Hover na imagem
          await page.mouse.move(img.centerX, img.centerY);
          await page.waitForTimeout(500);
          
          // Dispara hover events
          await page.evaluate((info) => {
            const el = document.elementFromPoint(info.centerX, info.centerY);
            if (el) {
              ['mouseenter', 'mouseover', 'pointerenter'].forEach(ev => {
                el.dispatchEvent(new MouseEvent(ev, {
                  bubbles: true, clientX: info.centerX, clientY: info.centerY
                }));
              });
            }
          }, img);
          
          await page.waitForTimeout(600);
          
          // Clica nos 3 pontinhos
          const moreClicked = await page.evaluate((info) => {
            const btns = Array.from(document.querySelectorAll('button'));
            const more = btns.filter(b => {
              const t = (b.textContent || '').trim().toLowerCase();
              return /more_vert|more_horiz|mais opç/.test(t);
            });
            if (more.length === 0) return false;
            more.sort((a, b) => {
              const ra = a.getBoundingClientRect();
              const rb = b.getBoundingClientRect();
              return Math.hypot(ra.left - info.centerX, ra.top - info.centerY) -
                     Math.hypot(rb.left - info.centerX, rb.top - info.centerY);
            });
            (more[0] as HTMLElement).click();
            return true;
          }, img);
          
          if (!moreClicked) {
            notes.push(`[${i}] more_vert não encontrado`);
            continue;
          }
          
          await page.waitForTimeout(800);
          
          // Procura "Archive" ou "Excluir" ou "Delete" no menu
          const deleteClicked = await page.evaluate(() => {
            const all = Array.from(document.querySelectorAll('button, [role="menuitem"], li, div, span'));
            const target = all.find(el => {
              const t = (el.textContent || '').trim().toLowerCase();
              return t.length < 40 && (/archive|excluir|delete|remover|apagar/.test(t));
            });
            if (target) { (target as HTMLElement).click(); return true; }
            return false;
          });
          
          if (deleteClicked) {
            deleted++;
            await page.waitForTimeout(800);
            
            // Confirma se aparecer modal de confirmação
            await page.evaluate(() => {
              const btns = Array.from(document.querySelectorAll('button'));
              const confirm = btns.find(b => {
                const t = (b.textContent || '').trim().toLowerCase();
                return /confirmar|sim|yes|ok|confirm/.test(t);
              });
              if (confirm) (confirm as HTMLElement).click();
            });
            
            await page.waitForTimeout(500);
          } else {
            // Fecha menu
            await page.keyboard.press('Escape').catch(() => {});
            notes.push(`[${i}] opção de excluir não encontrada no menu`);
          }
        } catch (e) {
          notes.push(`[${i}] erro: ${String(e).slice(0, 50)}`);
          await page.keyboard.press('Escape').catch(() => {});
        }
      }
      
      notes.push(`Deletadas: ${deleted}/${allImages.length - keepIndices.length}`);
      
      return { ok: deleted > 0, deleted, notes };
    } catch (err: any) {
      return { ok: false, error: String(err?.message || err), notes };
    }
  }

  

async flowAutomateSingleScene(settings: {
  prompt: string;
  aspectRatio: string;
  count: number;
  model: string;
  isFirstScene?: boolean;  // V5.5.0: se for a 1ª cena, abre novo projeto. Se não, mantém o atual
}) {
  // V5.5.0 - CORREÇÃO CRÍTICA: NÃO faz page.goto toda vez!
  // Apenas garante que existe contexto Flow, sem recarregar
  const { page } = await this.ensureContext('flow', { visible: true, targetUrl: URLS.flow });
  await page.bringToFront().catch(() => {});

  // V5.5.0: Só navega se não estiver em labs.google
  const currentUrl = page.url();
  if (!currentUrl.includes('labs.google')) {
    await page.goto(URLS.flow, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(1800);
  }

  const steps: Record<string, string> = {};
  const notes: string[] = [];

  // ── utilidades ─────────────────────────────────────��──────────────────────
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

  // ── V5.5.0: Abre projeto APENAS na primeira cena ──────────────────────────
  const homeText = (await getBody()).toLowerCase();
  const isOnHome = /novo projeto|new project|criar projeto/.test(homeText);
  
  if (settings.isFirstScene && isOnHome) {
    // Primeira cena E está na home → clica em novo projeto
    const opened = await clickFirstVisible([
      page.getByRole('button', { name: /novo projeto|new project|criar projeto/i }),
      page.getByText('Novo projeto', { exact: false }),
      page.getByText('New project', { exact: false }),
    ], 1500);
    steps.newProject = opened ? 'clicked' : 'not-found';
    await page.waitForTimeout(1500);
  } else if (!settings.isFirstScene && isOnHome) {
    // Cena 2+ MAS está na home → algo deu errado, tenta voltar para projeto ativo
    notes.push('AVISO: cena 2+ mas voltou pra home. Sistema pode ter perdido o contexto.');
    steps.newProject = 'fallback-home';
    // Tenta clicar em novo projeto mesmo assim para não travar
    const opened = await clickFirstVisible([
      page.getByRole('button', { name: /novo projeto|new project|criar projeto/i }),
    ], 1500);
    if (opened) steps.newProject = 'clicked-fallback';
  } else {
    steps.newProject = 'already-open';
  }

  // ── V5.5.1: composerArea robusto - funciona em qualquer estado do projeto
  // Tenta múltiplos seletores: textbox visível, textarea visível, ou xpath antigo
  const findComposerArea = () => {
    // Primeiro tenta o xpath antigo (funciona em projeto novo)
    const oldStyle = page.locator('xpath=//div[contains(., "O que você quer criar?")]').first();
    return oldStyle;
  };
  
  // V5.5.1 - Detecta se há um composer ativo (textarea/textbox visível)
  const hasActiveComposer = async () => {
    // Procura por textarea OU contenteditable que esteja visível
    const textareas = await safeCount(page.locator('textarea:visible, [contenteditable="true"]:visible, [role="textbox"]:visible'));
    return textareas > 0;
  };
  
  const composerArea = findComposerArea();
  const composerExists = await hasActiveComposer();
  notes.push(`composer ativo: ${composerExists}`);

  // ── 1. Abre chip de configuração ──────────────────────────────────────────
  // V5.5.1 - Prefere chip VISÍVEL e último (composer ativo, não chips antigos de imagens já geradas)
  const chipOpened = await clickFirstVisible([
    page.locator('button:visible').filter({ hasText: /nano banana|imagem 4|x[1-4]|16:9|4:3|1:1|3:4|9:16/i }).last(),
    page.locator('[role="button"]:visible').filter({ hasText: /nano banana|imagem 4|x[1-4]|16:9|4:3|1:1|3:4|9:16/i }).last(),
    page.locator('button').filter({ hasText: /nano banana|imagem 4|x[1-4]|16:9|4:3|1:1|3:4|9:16/i }).last(),
    composerArea.locator('button').filter({ hasText: /nano banana|imagem 4|x[1-4]|16:9|4:3|1:1|3:4|9:16/i }),
  ], 1000);
  steps.openChip = chipOpened ? 'ok' : 'not-found';

  await page.waitForTimeout(900);
  let panelBox = await findPanelBox();
  notes.push(`panelBox após chip: ${panelBox ? `${Math.round(panelBox.x)},${Math.round(panelBox.y)} ${Math.round(panelBox.width)}x${Math.round(panelBox.height)}` : 'null'}`);

  // ── 2. Seleciona "Imagem" - V5.5.2: TEXTO PRIMEIRO + VALIDAÇÃO ───────────
  // Bug do usuário: mesmo selecionando Imagem, ficava em Vídeo.
  // Solução: clica POR TEXTO (não coordenada) e VALIDA que está em modo Imagem.
  let modeSelected = false;
  
  // Tenta múltiplas vezes até confirmar que "Imagem" está ativo
  for (let attempt = 0; attempt < 3 && !modeSelected; attempt++) {
    if (panelBox) {
      // Primeiro: tenta CLICAR no texto "Imagem" dentro do popup
      const imagemClicked = await clickFirstVisible([
        page.locator('[role="menu"] >> text=/^Imagem$/').first(),
        page.locator('[role="listbox"] >> text=/^Imagem$/').first(),
        page.locator('[data-radix-popper-content-wrapper] >> text=/^Imagem$/').first(),
        page.locator('[role="dialog"] >> text=/^Imagem$/').first(),
        page.locator('[role="tab"]:has-text("Imagem")').first(),
        page.locator('button:has-text("Imagem")').filter({ hasNotText: 'Vídeo' }).first(),
        page.getByRole('button', { name: 'Imagem', exact: true }),
        page.getByText('Imagem', { exact: true }),
      ], 600);
      
      if (imagemClicked) {
        await page.waitForTimeout(700);
        notes.push(`tentativa ${attempt+1}: clicou Imagem por TEXTO`);
      } else {
        // Fallback por coordenada (se o texto não existir, tenta na posição esperada)
        await page.mouse.click(panelBox.x + 70, panelBox.y + 48);
        await page.waitForTimeout(700);
        notes.push(`tentativa ${attempt+1}: clicou Imagem por COORDENADA`);
      }
      
      // VALIDAÇÃO: verifica se o modo Imagem está ativo
      // Se Imagem está selecionado, geralmente:
      // - O botão "Imagem" tem aria-selected=true ou data-state=active
      // - Aparecem proporções (16:9, 4:3, etc) e quantidade (x1, x2, etc)
      // - O texto "Vídeo" pode aparecer mas SEM aria-selected
      const validation = await page.evaluate(() => {
        const allElements = Array.from(document.querySelectorAll('button, [role="tab"], [role="menuitem"]'));
        let imagemActive = false;
        let videoActive = false;
        let aspectVisible = false;
        
        for (const el of allElements) {
          const text = (el.textContent || '').trim();
          const ariaSelected = el.getAttribute('aria-selected');
          const dataState = el.getAttribute('data-state');
          const ariaPressed = el.getAttribute('aria-pressed');
          const isActive = ariaSelected === 'true' || dataState === 'active' || dataState === 'open' || ariaPressed === 'true';
          
          if (text === 'Imagem' && isActive) imagemActive = true;
          if (text === 'Vídeo' && isActive) videoActive = true;
          if (/^16:9$|^4:3$|^1:1$|^3:4$|^9:16$/.test(text)) aspectVisible = true;
        }
        
        // Também verifica se aparecem proporções no body
        const bodyText = document.body.textContent || '';
        const hasAspects = /16:9|4:3|9:16/.test(bodyText);
        
        return { imagemActive, videoActive, aspectVisible, hasAspects };
      });
      
      notes.push(`validação modo: imagemActive=${validation.imagemActive} videoActive=${validation.videoActive} aspectVisible=${validation.aspectVisible}`);
      
      // Considera que está em modo Imagem se:
      // - Imagem está marcada como ativa, OU
      // - Vídeo NÃO está marcado E proporções estão visíveis
      if (validation.imagemActive || (!validation.videoActive && validation.aspectVisible)) {
        modeSelected = true;
        steps.mode = `imagem (validado tentativa ${attempt+1})`;
        break;
      }
      
      notes.push(`Modo não validado, tentando novamente...`);
      // Se não validou, recalcula panelBox (popup pode ter mudado)
      panelBox = await findPanelBox() || panelBox;
    }
  }
  
  if (!modeSelected) {
    steps.mode = 'imagem-falhou-validacao';
  }

  // ── 3. Seleciona proporção - V5.5.2: TEXTO PRIMEIRO + VALIDAÇÃO ──────────
  let aspectSelected = false;
  for (let attempt = 0; attempt < 2 && !aspectSelected; attempt++) {
    // Tenta clicar no texto da proporção
    const aspectClicked = await clickFirstVisible([
      page.locator(`[role="menu"] >> text=/^${settings.aspectRatio}$/`).first(),
      page.locator(`[role="listbox"] >> text=/^${settings.aspectRatio}$/`).first(),
      page.locator(`[data-radix-popper-content-wrapper] >> text=/^${settings.aspectRatio}$/`).first(),
      page.locator(`button:has-text("${settings.aspectRatio}")`).first(),
      page.getByRole('button', { name: settings.aspectRatio, exact: true }),
    ], 500);
    
    if (aspectClicked) {
      await page.waitForTimeout(600);
      aspectSelected = true;
      steps.aspect = `${settings.aspectRatio} (texto)`;
      notes.push(`clicou proporção ${settings.aspectRatio} por TEXTO`);
      break;
    }
    
    // Fallback por coordenada
    if (panelBox && !aspectSelected) {
      const ratios = ['16:9', '4:3', '1:1', '3:4', '9:16'];
      const aspectIdx = Math.max(0, ratios.indexOf(settings.aspectRatio));
      const leftMargin = panelBox.width * 0.12;
      const usable = panelBox.width * 0.76;
      const gap = usable / 4;
      const ax = panelBox.x + leftMargin + aspectIdx * gap;
      const ay = panelBox.y + panelBox.height * 0.39;
      await page.mouse.click(ax, ay);
      await page.waitForTimeout(700);
      aspectSelected = true;
      steps.aspect = `${settings.aspectRatio} (coord)`;
      notes.push(`clicou proporção ${settings.aspectRatio} por COORDENADA`);
    }
  }
  
  if (!aspectSelected) {
    steps.aspect = 'falhou';
  }

  // ── 4. Seleciona quantidade - V5.5.2: TEXTO PRIMEIRO + VALIDAÇÃO ─────────
  // Bug do usuário: escolhia certo depois mudava errado.
  // Causa: dois cliques (um por coordenada, outro por algo) selecionavam valores diferentes.
  // Solução: UM ÚNICO clique por texto exato, com validação.
  let countSelected = false;
  const countLabel = `x${settings.count}`;
  
  for (let attempt = 0; attempt < 2 && !countSelected; attempt++) {
    const countClicked = await clickFirstVisible([
      page.locator(`[role="menu"] >> text=/^${countLabel}$/`).first(),
      page.locator(`[role="listbox"] >> text=/^${countLabel}$/`).first(),
      page.locator(`[data-radix-popper-content-wrapper] >> text=/^${countLabel}$/`).first(),
      page.locator(`button:has-text("${countLabel}")`).filter({ hasNotText: ':' }).first(),  // exclui "16:9" etc
      page.getByRole('button', { name: countLabel, exact: true }),
    ], 500);
    
    if (countClicked) {
      await page.waitForTimeout(600);
      
      // VALIDAÇÃO: verifica se o botão xN está realmente ativo
      const valid = await page.evaluate((target) => {
        const buttons = Array.from(document.querySelectorAll('button, [role="button"], [role="menuitem"]'));
        for (const b of buttons) {
          const text = (b.textContent || '').trim();
          if (text === target) {
            const ariaSelected = b.getAttribute('aria-selected');
            const dataState = b.getAttribute('data-state');
            const ariaPressed = b.getAttribute('aria-pressed');
            const isActive = ariaSelected === 'true' || dataState === 'active' || dataState === 'on' || ariaPressed === 'true';
            if (isActive) return true;
          }
        }
        return false;
      }, countLabel);
      
      countSelected = true;
      steps.count = `${countLabel} (texto${valid ? '+validado' : ''})`;
      notes.push(`clicou ${countLabel} por TEXTO ${valid ? '(validado)' : '(sem validacao)'}`);
      break;
    }
    
    // Fallback por coordenada (só se texto falhou)
    if (panelBox && !countSelected) {
      const countIdx = Math.min(3, Math.max(0, Number(settings.count) - 1));
      const cLeft = panelBox.width * 0.16;
      const cUsable = panelBox.width * 0.68;
      const cGap = cUsable / 3;
      const cx = panelBox.x + cLeft + countIdx * cGap;
      const cy = panelBox.y + panelBox.height * 0.55;
      await page.mouse.click(cx, cy);
      await page.waitForTimeout(700);
      countSelected = true;
      steps.count = `${countLabel} (coord)`;
      notes.push(`clicou ${countLabel} por COORDENADA`);
    }
  }
  
  if (!countSelected) {
    steps.count = 'falhou';
  }

  // ── 5. Seleciona modelo - V5.5.2: ABORDAGEM ROBUSTA ──────────────────────
  // Bug do usuário: às vezes seleciona modelo errado.
  // Solução: 
  // 1. Procura botão que contém o nome ATUAL do modelo (no chip)
  // 2. Clica nele para abrir menu de modelos
  // 3. Clica no modelo desejado e VALIDA que o chip mudou

  // Normaliza o nome do modelo alvo
  let targetModelName = 'Nano Banana 2';
  const ml = settings.model.toLowerCase();
  if (ml.includes('pro'))           targetModelName = 'Nano Banana Pro';
  else if (ml.includes('imagem 4')) targetModelName = 'Imagem 4';
  else                              targetModelName = 'Nano Banana 2';

  // Detecta qual modelo está atualmente no chip
  const currentModelInChip = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
    for (const b of buttons) {
      const text = (b.textContent || '').trim();
      if (/Nano Banana Pro/i.test(text)) return 'Nano Banana Pro';
      if (/Nano Banana 2/i.test(text))   return 'Nano Banana 2';
      if (/Imagem 4/i.test(text))        return 'Imagem 4';
    }
    return null;
  });
  notes.push(`modelo atual no chip: ${currentModelInChip || 'nenhum'}`);

  let modelMenuOpened = false;
  let selectedModel = '';

  // Se já está no modelo certo, não precisa fazer nada
  if (currentModelInChip === targetModelName) {
    selectedModel = targetModelName;
    notes.push(`modelo ${targetModelName} JÁ está selecionado, não precisa mudar`);
  } else {
    // ABORDAGEM 1: Clica no botão do modelo ATUAL (que abre o menu de modelos)
    if (currentModelInChip) {
      const modelButtonClicked = await clickFirstVisible([
        page.locator(`button:has-text("${currentModelInChip}")`).last(),
        page.locator(`[role="button"]:has-text("${currentModelInChip}")`).last(),
      ], 1000);
      if (modelButtonClicked) {
        await page.waitForTimeout(900);
        // Verifica se um popup novo apareceu
        const popups = await countPopups();
        if (popups.popper > 0 || popups.menu > 0 || popups.list > 0) {
          modelMenuOpened = true;
          steps.openModelMenu = `texto-modelo-atual (${currentModelInChip})`;
          notes.push(`abriu menu clicando no botão do modelo atual: ${currentModelInChip}`);
        }
      }
    }

    // ABORDAGEM 2 (fallback): Coordenadas relativas ao painel
    if (!modelMenuOpened && panelBox) {
      const beforePopups = await countPopups();
      const modelAttempts = [
        { xR: 0.50, yR: 0.79 },
        { xR: 0.78, yR: 0.79 },
        { xR: 0.50, yR: 0.86 },
        { xR: 0.83, yR: 0.86 },
        { xR: 0.50, yR: 0.72 },
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
          afterPopups.list   > beforePopups.list;

        if (popupIncreased) {
          modelMenuOpened = true;
          steps.openModelMenu = `coord (xR=${a.xR} yR=${a.yR})`;
          notes.push(`abriu menu modelo por coordenada xR=${a.xR} yR=${a.yR}`);
          break;
        }
      }
    }

    // ABORDAGEM 3 (último recurso): texto direto
    if (!modelMenuOpened) {
      modelMenuOpened = await clickFirstVisible([
        page.locator('button').filter({ hasText: /nano banana|imagem 4/i }).last(),
      ], 800);
      if (modelMenuOpened) {
        await page.waitForTimeout(800);
        steps.openModelMenu = 'fallback-texto';
      }
    }

    // Agora seleciona o modelo no sub-menu aberto
    if (modelMenuOpened) {
      await page.waitForTimeout(800);

      // V5.5.2: Aguarda o item "Nano Banana Pro" aparecer (até 2s)
      // Isso garante que o submenu renderizou
      try {
        await page.waitForSelector(`text=${targetModelName}`, { timeout: 2000 }).catch(() => {});
      } catch {}

      // O submenu é o ÚLTIMO popup aberto.
      const lastPopper = page.locator('[data-radix-popper-content-wrapper]').last();
      const lastMenu   = page.locator('[role="menu"]').last();

      const modelOk = await clickFirstVisible([
        lastPopper.getByText(targetModelName, { exact: false }),
        lastMenu.getByText(targetModelName, { exact: false }),
        page.locator('[role="listbox"]').last().getByText(targetModelName, { exact: false }),
        page.locator('[role="dialog"]').last().getByText(targetModelName, { exact: false }),
        page.getByRole('option', { name: new RegExp(targetModelName, 'i') }),
        page.getByText(targetModelName, { exact: false }).last(),
      ], 700);

      if (modelOk) {
        selectedModel = targetModelName;
        notes.push('selecao modelo ok por texto: ' + targetModelName);
        await page.waitForTimeout(700);

        // VALIDAÇÃO V5.5.2: Confirma que o chip mudou para o modelo escolhido
        const newCurrent = await page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
          for (const b of buttons) {
            const text = (b.textContent || '').trim();
            if (/Nano Banana Pro/i.test(text)) return 'Nano Banana Pro';
            if (/Nano Banana 2/i.test(text))   return 'Nano Banana 2';
            if (/Imagem 4/i.test(text))        return 'Imagem 4';
          }
          return null;
        });
        notes.push(`após clique, chip mostra: ${newCurrent || 'nada'}`);
        if (newCurrent === targetModelName) {
          notes.push(`✅ modelo ${targetModelName} VALIDADO no chip`);
        } else {
          notes.push(`⚠️ chip mostra "${newCurrent}" mas esperávamos "${targetModelName}"`);
        }
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
            await page.waitForTimeout(700);
            selectedModel = targetModelName;
            notes.push('selecao modelo ok por coordenada: ' + targetModelName);
          }
        } catch (e) {
          notes.push('falhou coordenada submenu: ' + String(e && e.message || e).slice(0, 100));
        }
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
  // V5.5.1 - Prefere busca GLOBAL (funciona em cenas 2+ onde composerArea pode estar vazio)
  let promptFilled = '';
  const promptLocators = [
    // Prioriza busca global por textarea/textbox visível
    page.locator('textarea:visible').last(),
    page.locator('div[role="textbox"]:visible').last(),
    page.locator('[contenteditable="true"]:visible').last(),
    // Fallback no composerArea (caso ainda exista)
    composerArea.locator('textarea'),
    composerArea.locator('div[role="textbox"]'),
    composerArea.locator('[contenteditable="true"]'),
    // Fallback global sem :visible
    page.locator('textarea').last(),
    page.locator('div[role="textbox"]').last(),
    page.locator('[contenteditable="true"]').last(),
  ];
  for (const loc of promptLocators) {
    try {
      if (!(await safeCount(loc))) continue;
      const el = loc.first();
      await el.scrollIntoViewIfNeeded().catch(() => {});
      await el.click({ timeout: 2500 });
      await page.waitForTimeout(200);
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
  // V5.5.7 - Submit calibrado pro Flow real (botão tem texto "arrow_forwardCriar")
  let submit = '';
  const submitClicked = await clickFirstVisible([
    // V5.5.7: seletor descoberto via DOM ao vivo
    page.locator('button').filter({ hasText: /^arrow_forwardCriar$/ }),
    page.locator('button[aria-label*="enviar" i], button[aria-label*="send" i], button[aria-label*="generate" i], button[aria-label*="gerar" i]'),
    page.locator('button[type="submit"]:visible').last(),
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
