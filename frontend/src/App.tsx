import React, { useEffect, useMemo, useRef, useState } from 'react'
import JSZip from 'jszip'

type StepKey = 'chatgpt' | 'images' | 'videos' | 'download'
type Agent = { id: string; name: string; source?: 'real' | 'fallback' }
type ChatStatus = { loggedInLikely: boolean; currentUrl?: string; backendSessionReady?: boolean; note?: string }
type ConversationItem = { role: 'user' | 'assistant'; text: string }
type Scene = { number: number; type?: string; voiceover?: string; imagePrompt?: string; videoPrompt?: string; raw?: string }
type ImageItem = {
  id: string
  sceneNumber: number
  variant: number
  url?: string
  status: 'locked' | 'pending' | 'processing' | 'uploaded' | 'approved'
  prompt: string
  note?: string
  progress?: number
}
type VideoItem = { sceneNumber: number; url?: string; status: 'pending' | 'uploaded' | 'approved'; prompt: string; note?: string }

const API_BASE_URL = 'http://localhost:3017'

async function apiRequest(endpoint: string, options: RequestInit = {}) {
  const res = await fetch(`${API_BASE_URL}${endpoint}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data?.ok === false) throw new Error(data?.error || `Falha em ${endpoint}`)
  return data
}
function conversationToRaw(conversation: ConversationItem[]) {
  return conversation.map((item, index) => `${index + 1}. [${item.role.toUpperCase()}]\n${item.text}`).join('\n\n')
}
function splitCharacters(text: string) {
  if (!text) return []
  return text.split(/\n{2,}|\n•|\n-|\n(?=[A-ZÁÉÍÓÚÂÊÔÃÕÇ][a-zà-ÿ])/).map((x) => x.trim()).filter(Boolean)
}
function parseScenes(raw: string): Scene[] {
  const scenes: Scene[] = []
  const splitRegex = /(?:^|\n)CENA\s+(\d+)\b/gi
  const matches = [...raw.matchAll(splitRegex)]
  if (!matches.length) return scenes
  for (let i = 0; i < matches.length; i++) {
    const number = Number(matches[i][1])
    const start = matches[i].index || 0
    const end = i + 1 < matches.length ? (matches[i + 1].index || raw.length) : raw.length
    const chunk = raw.slice(start, end).trim()
    const find = (patterns: RegExp[]) => {
      for (const pattern of patterns) {
        const m = chunk.match(pattern)
        if (m) return m[1].trim()
      }
      return ''
    }
    scenes.push({
      number,
      type: find([/(?:^|\n)(?:TIPO|Tipo)\s*:\s*([\s\S]*?)(?=\n(?:LOCUCAO|LOCUÇÃO|Locução|PROMPT_|CENA\s+\d+)|$)/i]),
      voiceover: find([/(?:^|\n)(?:LOCUCAO|LOCUÇÃO|Locução)\s*:\s*([\s\S]*?)(?=\n(?:PROMPT_|CENA\s+\d+)|$)/i]),
      imagePrompt: find([/(?:^|\n)(?:PROMPT_IMAGEM|Prompt imagem|Prompt image|Prompt de imagem)\s*:?\s*([\s\S]*?)(?=\n(?:PROMPT_VIDEO|Prompt vídeo|Prompt video|Prompt de vídeo|CENA\s+\d+)|$)/i]),
      videoPrompt: find([/(?:^|\n)(?:PROMPT_VIDEO|Prompt vídeo|Prompt video|Prompt de vídeo)\s*:?\s*([\s\S]*?)(?=\nCENA\s+\d+|$)/i]),
      raw: chunk,
    })
  }
  return scenes
}
function parseProjectResponse(raw: string) {
  const normalize = raw || ''
  const block = (labels: string[]) => {
    for (const label of labels) {
      const regex = new RegExp(`(?:^|\\n)${label}\\s*:?\\s*\\n?([\\s\\S]*?)(?=\\n(?:TÍTULO|TITULO|TEMA|HISTÓRIA|HISTORIA|PERSONAGENS|CAPA|CENA)\\b|$)`, 'i')
      const match = normalize.match(regex)
      if (match) return match[1].trim()
    }
    return ''
  }
  let coverPrompt = ''
  const coverMatch = normalize.match(/(?:^|\n)CAPA\s*:?\s*\n?(?:Prompt image\s*\n?)?([\s\S]*?)(?=\nCENA\s+\d+|(?:\nCENAS\b)|$)/i)
  if (coverMatch) coverPrompt = coverMatch[1].trim()
  return {
    title: block(['TÍTULO', 'TITULO']),
    theme: block(['TEMA']),
    story: block(['HISTÓRIA', 'HISTORIA']),
    characterCards: splitCharacters(block(['PERSONAGENS'])),
    coverPrompt,
    scenes: parseScenes(normalize),
  }
}
function detectChatCompleted(raw: string, scenes: Scene[]) {
  const lower = raw.toLowerCase()
  return scenes.length > 0 || lower.includes('prompt de vídeo') || lower.includes('prompt_video') || lower.includes('cena 1')
}
function dotColor(ok:boolean){ return ok ? '#22c55e' : '#ef4444' }
function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
}
async function blobFromObjectUrl(url: string) { const res = await fetch(url); return await res.blob() }

const styles: Record<string, React.CSSProperties> = {
  page: { minHeight: '100vh', padding: 24, background: '#05090f', color: '#e5eef8', fontFamily: 'Inter, Arial, sans-serif' },
  container: { maxWidth: 1450, margin: '0 auto' },
  hero: { border: '1px solid rgba(255,255,255,0.06)', borderRadius: 26, padding: 24, background: 'linear-gradient(180deg, rgba(7,13,24,0.98), rgba(6,10,18,0.98))' },
  title: { fontSize: 32, fontWeight: 800, margin: 0 },
  sub: { color: '#7f8c9d', marginTop: 8 },
  stepWrap: { display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10, marginTop: 22 },
  stepCard: { border: '1px solid rgba(255,255,255,0.08)', borderRadius: 16, padding: 14, background: 'rgba(255,255,255,0.03)', cursor: 'pointer' },
  stepActive: { background: 'linear-gradient(180deg, rgba(34,128,255,0.18), rgba(34,128,255,0.08))', border: '1px solid rgba(70,140,255,0.22)' },
  stepLocked: { opacity: 0.45, cursor: 'not-allowed' },
  content: { display: 'grid', gridTemplateColumns: '1.05fr 1fr', gap: 18, marginTop: 20 },
  panel: { border: '1px solid rgba(255,255,255,0.08)', borderRadius: 20, padding: 18, background: 'rgba(255,255,255,0.03)' },
  panelTitle: { fontSize: 18, fontWeight: 800, marginBottom: 14 },
  row3: { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12 },
  row2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 },
  btnPrimary: { border: 'none', borderRadius: 14, padding: '12px 14px', cursor: 'pointer', fontWeight: 700, background: 'linear-gradient(180deg, #2c9cff 0%, #136bff 100%)', color: '#fff' },
  btnSecondary: { border: '1px solid rgba(255,255,255,0.1)', borderRadius: 14, padding: '12px 14px', cursor: 'pointer', fontWeight: 700, background: 'rgba(255,255,255,0.03)', color: '#d8e4f2' },
  btnSuccess: { border: 'none', borderRadius: 14, padding: '12px 14px', cursor: 'pointer', fontWeight: 800, background: 'linear-gradient(180deg, #22c55e 0%, #16a34a 100%)', color: '#fff', boxShadow: '0 0 24px rgba(34,197,94,0.4)' },
  btnWarn: { border: '1px solid rgba(255,255,255,0.1)', borderRadius: 14, padding: '10px 12px', cursor: 'pointer', fontWeight: 700, background: 'rgba(245,158,11,0.14)', color: '#fde68a' },
  label: { fontSize: 13, color: '#8ea0b4', marginBottom: 8, display: 'block' },
  input: { width: '100%', background: '#0b1017', color: '#e7eef7', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 14, padding: 12 },
  textarea: { width: '100%', minHeight: 120, background: '#0b1017', color: '#e7eef7', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 14, padding: 12, resize: 'vertical' },
  statusBox: { padding: 14, borderRadius: 14, background: '#0b1017', border: '1px solid rgba(255,255,255,0.08)', color: '#d9e6f5', maxHeight: 180, overflow: 'auto' },
  charCard: { border: '1px solid rgba(255,255,255,0.08)', borderRadius: 14, padding: 12, background: '#0b1017' },
  promptBox: { whiteSpace: 'pre-wrap', background: '#0b1017', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 14, padding: 12, fontSize: 12, lineHeight: 1.5, color: '#d9e6f5', maxHeight: 280, overflow: 'auto' },
  toastOk: { marginTop: 14, padding: 12, borderRadius: 14, background: 'rgba(34,197,94,0.12)', border: '1px solid rgba(34,197,94,0.28)', color: '#b8f7c8' },
  toastErr: { marginTop: 14, padding: 12, borderRadius: 14, background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.28)', color: '#fecaca' },
  sceneGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 },
  sceneCard: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: 12, borderRadius: 14, background: '#0b1017', border: '1px solid rgba(255,255,255,0.08)' },
  helperBtn: { width: 28, height: 28, borderRadius: 999, border: '1px solid rgba(255,255,255,0.15)', background: 'rgba(255,255,255,0.04)', color: '#fff', cursor: 'pointer', fontWeight: 800 },
  modalBackdrop: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.58)', display: 'grid', placeItems: 'center', padding: 20 },
  modal: { width: 'min(900px, 100%)', maxHeight: '86vh', overflow: 'auto', borderRadius: 20, background: '#071018', border: '1px solid rgba(255,255,255,0.1)', padding: 18 },
  mediaGrid: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 16 },
  mediaCard: { border: '1px solid rgba(255,255,255,0.08)', borderRadius: 18, overflow: 'hidden', background: '#0b1017' },
  mediaActions: { display: 'flex', gap: 8, padding: 12, flexWrap: 'wrap' },
  mediaMeta: { padding: 12 },
  fileInput: { display: 'none' },
  serviceRow: { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12, marginTop: 18 },
  serviceCard: { border: '1px solid rgba(255,255,255,0.08)', borderRadius: 16, padding: 14, background: 'rgba(255,255,255,0.03)' },
  spinner: { display:'inline-block', width:14, height:14, border:'2px solid rgba(255,255,255,0.3)', borderTopColor:'#fff', borderRadius:'50%', animation:'spin 1s linear infinite', marginRight:8 },
  progressWrap: { height: 8, background:'#122030', borderRadius:999, overflow:'hidden', marginTop:8 },
}

function Dot({ ok }: { ok: boolean }) { return <span style={{ width:10, height:10, borderRadius:999, display:'inline-block', background:dotColor(ok) }} /> }
function Spinner(){ return <span style={styles.spinner} /> }

export default function App() {
  const [step, setStep] = useState<StepKey>('chatgpt')
  const [agents, setAgents] = useState<Agent[]>([])
  const [selectedAgentId, setSelectedAgentId] = useState('')
  const [services, setServices] = useState<Record<'chatgpt'|'flow'|'grok', ChatStatus>>({
    chatgpt:{ loggedInLikely:false, note:'ChatGPT deslogado' },
    flow:{ loggedInLikely:false, note:'FLOW deslogado' },
    grok:{ loggedInLikely:false, note:'Grok deslogado' },
  })
  const [ideaMode, setIdeaMode] = useState<'direct'|'ideas'>('direct')
  const [directMessage, setDirectMessage] = useState('quero uma história sobre traição')
  const [ideasSubject, setIdeasSubject] = useState('vídeos curtos dramáticos nos Estados Unidos')
  const [ideasCount, setIdeasCount] = useState(10)
  const [ideasExtra, setIdeasExtra] = useState('')
  const [conversation, setConversation] = useState<ConversationItem[]>([])
  const [latest, setLatest] = useState('')
  const [sending, setSending] = useState(false)
  const [loading, setLoading] = useState({
    agents:false, history:false, openChat:false, openFlow:false, openGrok:false, send:false, startImages:false, approveAllImages:false, startVideos:false, openNewProject:false, testFlowConfig:false, testImageOnly:false, testChipOnly:false, testSelectImage:false, testSelectImagePosition:false, testAspect:false, testCount:false, testModelMenu536:false
  })
  const [sendNotice, setSendNotice] = useState('')
  const [sendError, setSendError] = useState('')
  const [sceneDetail, setSceneDetail] = useState<Scene | null>(null)
  const [images, setImages] = useState<ImageItem[]>([])
  const [videos, setVideos] = useState<VideoItem[]>([])
  const [imageSettings, setImageSettings] = useState({ orientation:'9:16', perScene:4, model:'Nano Banana 2' })
  const [imageNotice, setImageNotice] = useState('')
  const [videoNotice, setVideoNotice] = useState('')
  const [downloadNotice, setDownloadNotice] = useState('')
  const imageFileRefs = useRef<Record<string, HTMLInputElement | null>>({})
  const videoFileRefs = useRef<Record<number, HTMLInputElement | null>>({})

  const raw = useMemo(() => conversationToRaw(conversation), [conversation])
  const parsed = useMemo(() => parseProjectResponse(raw), [raw])
  const chatCompleted = useMemo(() => detectChatCompleted(raw, parsed.scenes || []), [raw, parsed.scenes])

  const sceneImageMap = useMemo(() => {
    const map: Record<number, ImageItem[]> = {}
    for (const img of images) {
      if (!map[img.sceneNumber]) map[img.sceneNumber] = []
      map[img.sceneNumber].push(img)
    }
    return map
  }, [images])

  const imagesCompleted = useMemo(() => {
    if (!images.length) return false
    return parsed.scenes.every(scene => {
      const arr = [...(sceneImageMap[scene.number] || [])].sort((a,b)=>a.variant-b.variant)
      return arr.length === imageSettings.perScene && arr.every(x => x.status === 'approved')
    })
  }, [images, parsed.scenes, sceneImageMap, imageSettings])

  const videosCompleted = videos.length > 0 && videos.every(v => v.status === 'approved')

  useEffect(() => { refreshAllServiceStatus().catch(() => {}) }, [])
  useEffect(() => {
    if (step !== 'chatgpt') return
    const id = setInterval(() => { refreshConversation().catch(() => {}) }, 10000)
    return () => clearInterval(id)
  }, [step])

  const refreshServiceStatus = async (service:'chatgpt'|'flow'|'grok') => {
    try {
      const data = await apiRequest(`/service-status?service=${service}`)
      setServices(prev => ({ ...prev, [service]: data.status }))
    } catch (err:any) {
      setServices(prev => ({ ...prev, [service]: { loggedInLikely:false, note:String(err.message || err) } }))
    }
  }
  const refreshAllServiceStatus = async () => { await Promise.all([refreshServiceStatus('chatgpt'), refreshServiceStatus('flow'), refreshServiceStatus('grok')]) }

  const loadAgents = async () => {
    setLoading(prev => ({ ...prev, agents:true }))
    setSendNotice('Identificando GPTs...')
    try {
      const data = await apiRequest('/agents')
      setAgents(data.agents || [])
      setSelectedAgentId(data.agents?.[0]?.id || '')
      await refreshServiceStatus('chatgpt')
      setSendNotice('GPTs identificados com sucesso.')
    } catch (err:any) {
      setSendError(err.message || 'Falha ao identificar GPTs.')
    } finally {
      setLoading(prev => ({ ...prev, agents:false }))
    }
  }

  const refreshConversation = async () => {
    setLoading(prev => ({ ...prev, history:true }))
    try {
      const data = await apiRequest('/conversation')
      setConversation(data.conversation || [])
      const assistants = (data.conversation || []).filter((x: ConversationItem) => x.role === 'assistant')
      setLatest(assistants.length ? assistants[assistants.length - 1].text : '')
      setSendNotice('Histórico atualizado.')
    } catch (err:any) {
      setSendError(err.message || 'Falha ao atualizar histórico.')
    } finally {
      setLoading(prev => ({ ...prev, history:false }))
    }
  }

  const openService = async (service:'chatgpt'|'flow'|'grok') => {
    const loadingKey = service === 'chatgpt' ? 'openChat' : service === 'flow' ? 'openFlow' : 'openGrok'
    const setNotice = service === 'chatgpt' ? setSendNotice : service === 'flow' ? setImageNotice : setVideoNotice
    setLoading(prev => ({ ...prev, [loadingKey]: true }))
    setNotice(`Abrindo ${service}...`)
    try {
      await apiRequest('/open-service', { method:'POST', body: JSON.stringify({ service }) })
      await refreshServiceStatus(service)
      setNotice(`${service} aberto.`)
    } catch (err:any) {
      setNotice(err.message || 'Falha ao abrir serviço.')
    } finally {
      setLoading(prev => ({ ...prev, [loadingKey]: false }))
    }
  }

  const send = async () => {
    if (!selectedAgentId) return
    setSending(true)
    setLoading(prev => ({ ...prev, send:true }))
    setSendNotice('Enviando mensagem...')
    setSendError('')
    try {
      const data = ideaMode === 'direct'
        ? await apiRequest('/direct-message', { method:'POST', body: JSON.stringify({ agentId:selectedAgentId, prompt:directMessage }) })
        : await apiRequest('/ask-ideas', { method:'POST', body: JSON.stringify({ agentId:selectedAgentId, subject:ideasSubject, count:ideasCount, extraInstructions:ideasExtra }) })
      setConversation(data.conversation || [])
      setLatest(data.rawResponse || '')
      setSendNotice(data.confirmation || 'Mensagem enviada com sucesso.')
      await refreshServiceStatus('chatgpt')
    } catch (err:any) {
      setSendError(err.message || 'Falha ao enviar mensagem.')
    } finally {
      setSending(false)
      setLoading(prev => ({ ...prev, send:false }))
    }
  }

  const stepEnabled = {
    chatgpt: true,
    images: chatCompleted,
    videos: chatCompleted && imagesCompleted,
    download: chatCompleted && imagesCompleted && videosCompleted,
  }
  const trySetStep = (target: StepKey) => { if (stepEnabled[target]) setStep(target) }

  const advanceProgressForScene = async (sceneNumber:number) => {
    for (let p = 5; p <= 95; p += 15) {
      setImages(prev => prev.map(img => img.sceneNumber === sceneNumber && img.status === 'processing' ? { ...img, progress:p, note:`Processando ${p}%` } : img))
      await new Promise(r => setTimeout(r, 250))
    }
  }


  const openNewProjectOnly = async () => {
    setLoading(prev => ({ ...prev, openNewProject:true }))
    setImageNotice('Tentando clicar em Novo projeto...')
    try {
      const data = await apiRequest('/flow-open-new-project', { method:'POST', body: JSON.stringify({}) })
      setImageNotice(data.result?.note || 'Processo concluído.')
      await refreshServiceStatus('flow')
    } catch (err:any) {
      setImageNotice(err.message || 'Falha ao clicar em Novo projeto.')
    } finally {
      setLoading(prev => ({ ...prev, openNewProject:false }))
    }
  }


  const testFlowConfigOnly = async () => {
    setLoading(prev => ({ ...prev, testFlowConfig:true }))
    setImageNotice('Testando configurações do chip do Flow...')
    try {
      const data = await apiRequest('/flow-test-config', {
        method:'POST',
        body: JSON.stringify({
          aspectRatio: imageSettings.orientation,
          count: imageSettings.perScene,
          model: imageSettings.model,
        })
      })
      const steps = data.result?.steps || {}
      setImageNotice(`Teste concluído. mode=${steps.mode || '-'} aspect=${steps.aspect || '-'} count=${steps.count || '-'} model=${steps.model || '-'}`)
      await refreshServiceStatus('flow')
    } catch (err:any) {
      setImageNotice(err.message || 'Falha ao testar configurações do Flow.')
    } finally {
      setLoading(prev => ({ ...prev, testFlowConfig:false }))
    }
  }


  const testFlowImageOnly = async () => {
    setLoading(prev => ({ ...prev, testImageOnly:true }))
    setImageNotice('Testando somente a seleção de Imagem...')
    try {
      const data = await apiRequest('/flow-test-image-only', { method:'POST', body: JSON.stringify({}) })
      const r = data.result || {}
      setImageNotice(`Imagem only: chip=${r.chipClicked ? 'ok' : 'falhou'} imagem=${r.imageClicked ? 'ok' : 'falhou'} | ${Array.isArray(r.notes) ? r.notes.join(' | ') : ''}`)
      await refreshServiceStatus('flow')
    } catch (err:any) {
      setImageNotice(err.message || 'Falha ao testar Imagem.')
    } finally {
      setLoading(prev => ({ ...prev, testImageOnly:false }))
    }
  }


  const testFlowChipOnly = async () => {
    setLoading(prev => ({ ...prev, testChipOnly:true }))
    setImageNotice('Testando somente abrir o chip de configuração...')
    try {
      const data = await apiRequest('/flow-test-chip-only', { method:'POST', body: JSON.stringify({}) })
      const r = data.result || {}
      setImageNotice(`Chip only: chip=${r.chipClicked ? 'ok' : 'falhou'} método=${r.method || '-'} aspect=${r.bodyHasAspect ? 'sim' : 'não'} qtd=${r.bodyHasQuantidade ? 'sim' : 'não'} modelo=${r.bodyHasModelo ? 'sim' : 'não'} | ${Array.isArray(r.notes) ? r.notes.join(' | ') : ''}`)
      await refreshServiceStatus('flow')
    } catch (err:any) {
      setImageNotice(err.message || 'Falha ao testar chip.')
    } finally {
      setLoading(prev => ({ ...prev, testChipOnly:false }))
    }
  }


  const testFlowSelectImage = async () => {
    setLoading(prev => ({ ...prev, testSelectImage:true }))
    setImageNotice('Testando abrir chip e selecionar Imagem...')
    try {
      const data = await apiRequest('/flow-test-select-image', { method:'POST', body: JSON.stringify({}) })
      const r = data.result || {}
      setImageNotice(`Selecionar Imagem: chip=${r.chipClicked ? 'ok' : 'falhou'} imagem=${r.imageClicked ? 'ok' : 'falhou'} aspect=${r.bodyHasAspect ? 'sim' : 'não'} qtd=${r.bodyHasQuantidade ? 'sim' : 'não'} modelo=${r.bodyHasModelo ? 'sim' : 'não'} | ${Array.isArray(r.notes) ? r.notes.join(' | ') : ''}`)
      await refreshServiceStatus('flow')
    } catch (err:any) {
      setImageNotice(err.message || 'Falha ao selecionar Imagem.')
    } finally {
      setLoading(prev => ({ ...prev, testSelectImage:false }))
    }
  }


  const testFlowSelectImagePosition = async () => {
    setLoading(prev => ({ ...prev, testSelectImagePosition:true }))
    setImageNotice('Testando selecionar Imagem por posição...')
    try {
      const data = await apiRequest('/flow-test-select-image-position', { method:'POST', body: JSON.stringify({}) })
      const r = data.result || {}
      setImageNotice(`Imagem posição: chip=${r.chipClicked ? 'ok' : 'falhou'} imagem=${r.imageClicked ? 'ok' : 'falhou'} método=${r.method || '-'} aspect=${r.bodyHasAspect ? 'sim' : 'não'} qtd=${r.bodyHasQuantidade ? 'sim' : 'não'} modelo=${r.bodyHasModelo ? 'sim' : 'não'} | ${Array.isArray(r.notes) ? r.notes.join(' | ') : ''}`)
      await refreshServiceStatus('flow')
    } catch (err:any) {
      setImageNotice(err.message || 'Falha ao selecionar Imagem por posição.')
    } finally {
      setLoading(prev => ({ ...prev, testSelectImagePosition:false }))
    }
  }


  const testFlowAspect = async () => {
    setLoading(prev => ({ ...prev, testAspect:true }))
    setImageNotice('Testando seleção de proporção...')
    try {
      const data = await apiRequest('/flow-test-aspect-calibrated', {
        method:'POST',
        body: JSON.stringify({ aspectRatio: imageSettings.orientation })
      })
      const r = data.result || {}
      setImageNotice(`Proporção calibrada: chip=${r.chipClicked ? 'ok' : 'falhou'} imagem=${r.imageClicked ? 'ok' : 'falhou'} clique=${r.aspectClicked ? 'ok' : 'falhou'} método=${r.method || '-'} ponto=${r.clickedPoint ? `${r.clickedPoint.x},${r.clickedPoint.y}` : '-'} | ${Array.isArray(r.notes) ? r.notes.join(' | ') : ''}`)
      await refreshServiceStatus('flow')
    } catch (err:any) {
      setImageNotice(err.message || 'Falha ao testar proporção.')
    } finally {
      setLoading(prev => ({ ...prev, testAspect:false }))
    }
  }


  const testFlowCount = async () => {
    setLoading(prev => ({ ...prev, testCount:true }))
    setImageNotice('Testando seleção de quantidade...')
    try {
      const data = await apiRequest('/flow-test-count', {
        method:'POST',
        body: JSON.stringify({
          aspectRatio: imageSettings.orientation,
          count: imageSettings.perScene,
        })
      })
      const r = data.result || {}
      setImageNotice(`Quantidade: chip=${r.chipClicked ? 'ok' : 'falhou'} imagem=${r.imageClicked ? 'ok' : 'falhou'} proporção=${r.aspectClicked ? 'ok' : 'falhou'} quantidade=${r.countClicked ? 'ok' : 'falhou'} ponto=${r.clickedCountPoint ? `${r.clickedCountPoint.x},${r.clickedCountPoint.y}` : '-'} | ${Array.isArray(r.notes) ? r.notes.join(' | ') : ''}`)
      await refreshServiceStatus('flow')
    } catch (err:any) {
      setImageNotice(err.message || 'Falha ao testar quantidade.')
    } finally {
      setLoading(prev => ({ ...prev, testCount:false }))
    }
  }


  const testFlowModelMenu536 = async () => {
    setLoading(prev => ({ ...prev, testModelMenu536:true }))
    setImageNotice('Testando menu do modelo V5.3.6-FORCED-FINAL-UNIQUE...')
    try {
      const data = await apiRequest('/flow-test-model-menu-v536-final', {
        method:'POST',
        body: JSON.stringify({
          aspectRatio: imageSettings.orientation,
          count: imageSettings.perScene,
        })
      })
      const r = data.result || {}
      setImageNotice(`Menu modelo V536: version=${r.version || '-'} chip=${r.chipClicked ? 'ok' : 'falhou'} imagem=${r.imageClicked ? 'ok' : 'falhou'} proporção=${r.aspectClicked ? 'ok' : 'falhou'} quantidade=${r.countClicked ? 'ok' : 'falhou'} menu=${r.modelMenuClicked ? 'ok' : 'falhou'} método=${r.method || '-'} ponto=${r.clickedModelMenuPoint ? `${r.clickedModelMenuPoint.x},${r.clickedModelMenuPoint.y}` : '-'} | ${Array.isArray(r.notes) ? r.notes.join(' | ') : ''}`)
      await refreshServiceStatus('flow')
    } catch (err:any) {
      setImageNotice(err.message || 'Falha ao testar menu do modelo V5.3.6-FORCED-FINAL-UNIQUE.')
    } finally {
      setLoading(prev => ({ ...prev, testModelMenu536:false }))
    }
  }

  const startImages = async () => {
    if (!parsed.scenes?.length) return
    setLoading(prev => ({ ...prev, startImages:true }))
    setImageNotice('Executando Start automático para todas as cenas...')
    const queue: ImageItem[] = []
    parsed.scenes.forEach((scene, sceneIndex) => {
      for (let i = 1; i <= imageSettings.perScene; i++) {
        queue.push({
          id:`${scene.number}-${i}`,
          sceneNumber:scene.number,
          variant:i,
          url:undefined,
          status: sceneIndex === 0 ? 'processing' : 'locked',
          prompt: scene.imagePrompt || '',
          note: sceneIndex === 0 ? 'Cena ativa' : 'Aguardando cena anterior',
          progress: sceneIndex === 0 ? 1 : 0
        })
      }
    })
    setImages(queue)

    try {
      for (const [index, scene] of parsed.scenes.entries()) {
        if (index > 0) {
          setImages(prev => prev.map(img => img.sceneNumber === scene.number ? { ...img, status:'processing', progress:1, note:'Cena ativa' } : img))
        }
        await advanceProgressForScene(scene.number)
        const result = await apiRequest('/flow-automate-single', {
          method:'POST',
          body: JSON.stringify({
            prompt: scene.imagePrompt || '',
            aspectRatio: imageSettings.orientation,
            count: imageSettings.perScene,
            model: imageSettings.model,
          })
        })
        const ok = !!result?.result?.ok
        const steps = result?.result?.steps || {}
        const modelOk = steps.model && !steps.model.includes('falhou') && !steps.model.includes('sem-painel')
        const noteDetail = [
          ok ? '✅ Automação completa' : '⚠️ Automação parcial',
          `Modelo: ${modelOk ? steps.model : '❌ ' + (steps.model || 'não selecionado')}`,
          `Proporção: ${steps.aspect || '?'}`,
          `Qtd: ${steps.count || '?'}`,
        ].join(' · ')
        setImages(prev => prev.map(img => img.sceneNumber === scene.number ? {
          ...img,
          status:'pending',
          progress: ok ? 100 : 50,
          note: noteDetail
        } : img))
      }
      await refreshServiceStatus('flow')
      setImageNotice('Start concluído. O Flow recebeu a tentativa de automação para todas as cenas.')
    } catch (err:any) {
      setImageNotice(`Falha no Start: ${err.message || err}`)
    } finally {
      setLoading(prev => ({ ...prev, startImages:false }))
    }
  }

  const unlockNextSceneIfNeeded = (sceneNumber: number, nextState: ImageItem[]) => {
    const currentScene = nextState.filter(s => s.sceneNumber === sceneNumber)
    const currentApproved = currentScene.length > 0 && currentScene.every(s => s.status === 'approved')
    if (!currentApproved) return nextState
    // Busca o próximo número de cena real existente (suporta numeração com gaps)
    const allSceneNumbers = [...new Set(nextState.map(s => s.sceneNumber))].sort((a, b) => a - b)
    const currentIdx = allSceneNumbers.indexOf(sceneNumber)
    const nextSceneNumber = currentIdx >= 0 && currentIdx + 1 < allSceneNumbers.length
      ? allSceneNumbers[currentIdx + 1]
      : undefined
    if (nextSceneNumber === undefined) return nextState
    return nextState.map(slot =>
      slot.sceneNumber === nextSceneNumber && slot.status === 'locked'
        ? { ...slot, status:'pending', note:'Cena ativa', progress:0 }
        : slot
    )
  }

  const handleUploadImage = (id:string, file?: File | null) => {
    if (!file) return
    const url = URL.createObjectURL(file)
    setImages(prev => prev.map(slot => slot.id === id ? { ...slot, url, status:'uploaded', note:file.name, progress:100 } : slot))
    setImageNotice('Imagem enviada com sucesso.')
  }
  const approveImage = (id:string) => {
    setImages(prev => {
      const updated = prev.map(slot => slot.id === id ? { ...slot, status:'approved', note:'Imagem aprovada', progress:100 } : slot)
      const slot = updated.find(s => s.id === id)
      return slot ? unlockNextSceneIfNeeded(slot.sceneNumber, updated) : updated
    })
    setImageNotice('Imagem aprovada.')
  }
  const retryImage = (id:string) => {
    setImages(prev => prev.map(slot => slot.id === id ? { ...slot, status:'pending', url:undefined, note:'Refação pronta para novo upload', progress:0 } : slot))
    setImageNotice('Imagem marcada para refação.')
  }
  const approveAllImages = () => {
    setLoading(prev => ({ ...prev, approveAllImages:true }))
    setImages(prev => prev.map(slot => slot.url ? { ...slot, status:'approved', note:'Aprovada em lote', progress:100 } : slot))
    setImageNotice('Todas as imagens enviadas foram aprovadas.')
    setLoading(prev => ({ ...prev, approveAllImages:false }))
  }

  const startVideos = async () => {
    if (!imagesCompleted) return
    setLoading(prev => ({ ...prev, startVideos:true }))
    setVideoNotice('Preparando fila de vídeos...')
    const queue: VideoItem[] = parsed.scenes.map(scene => ({ sceneNumber:scene.number, status:'pending', prompt:scene.videoPrompt || '', note:`Cena ${scene.number}` }))
    setVideos(queue)
    setVideoNotice('Fila de vídeos preparada.')
    setLoading(prev => ({ ...prev, startVideos:false }))
  }
  const handleUploadVideo = (sceneNumber:number, file?: File | null) => {
    if (!file) return
    const url = URL.createObjectURL(file)
    setVideos(prev => prev.map(v => v.sceneNumber === sceneNumber ? { ...v, url, status:'uploaded', note:file.name } : v))
    setVideoNotice('Vídeo enviado com sucesso.')
  }
  const approveVideo = (sceneNumber:number) => {
    setVideos(prev => prev.map(v => v.sceneNumber === sceneNumber ? { ...v, status:'approved', note:'Vídeo aprovado' } : v))
    setVideoNotice('Vídeo aprovado.')
  }
  const retryVideo = (sceneNumber:number) => {
    setVideos(prev => prev.map(v => v.sceneNumber === sceneNumber ? { ...v, status:'pending', url:undefined, note:'Refação pronta para novo upload' } : v))
    setVideoNotice('Vídeo marcado para refação.')
  }

  const exportPrompts = async () => {
    const text = [
      `TÍTULO:\n${parsed.title || ''}`,
      `TEMA:\n${parsed.theme || ''}`,
      `HISTÓRIA:\n${parsed.story || ''}`,
      `PROMPT DA CAPA:\n${parsed.coverPrompt || ''}`,
      ...parsed.scenes.map((s) => `CENA ${s.number}\nPROMPT_IMAGEM:\n${s.imagePrompt || ''}\n\nPROMPT_VIDEO:\n${s.videoPrompt || ''}`)
    ].join('\n\n')
    downloadBlob(new Blob([text], { type:'text/plain;charset=utf-8' }), 'prompts-do-projeto.txt')
    setDownloadNotice('Prompts exportados com sucesso.')
  }
  const exportImagesZip = async () => {
    const zip = new JSZip()
    for (const img of images) {
      if (!img.url) continue
      const blob = await blobFromObjectUrl(img.url)
      zip.file(`cena-${img.sceneNumber}-imagem-${img.variant}.png`, blob)
    }
    const content = await zip.generateAsync({ type:'blob' })
    downloadBlob(content, 'imagens-do-projeto.zip')
    setDownloadNotice('Imagens exportadas com sucesso.')
  }
  const exportVideosZip = async () => {
    const zip = new JSZip()
    for (const v of videos) {
      if (!v.url) continue
      const blob = await blobFromObjectUrl(v.url)
      zip.file(`cena-${v.sceneNumber}-video.mp4`, blob)
    }
    const content = await zip.generateAsync({ type:'blob' })
    downloadBlob(content, 'videos-do-projeto.zip')
    setDownloadNotice('Vídeos exportados com sucesso.')
  }

  return (
    <div style={styles.page}>
      <style>{`@keyframes spin { from { transform: rotate(0deg);} to { transform: rotate(360deg);} }`}</style>
      <div style={styles.container}>
        <div style={styles.hero}>
          <h1 style={styles.title}>DarkPlanner V5.3.6-FORCED-FINAL-UNIQUE</h1>
          <div style={{...styles.toastOk, marginTop: 12}}>VERSÃO ATIVA: V5.3.6-FORCED-FINAL-UNIQUE</div>
          <div style={styles.sub}>Rollback seguro da V4.8. Mantém a base anterior sem o diagnóstico que causou erro de contexto.</div>

          <div style={styles.serviceRow}>
            {(['chatgpt','flow','grok'] as const).map((service) => (
              <div key={service} style={styles.serviceCard}>
                <div style={{display:'flex',alignItems:'center',gap:8}}>
                  <Dot ok={!!services[service]?.loggedInLikely} />
                  <b>{service === 'chatgpt' ? 'ChatGPT' : service === 'flow' ? 'Flow' : 'Grok'}</b>
                </div>
                <div style={{marginTop:8,color:'#b8c6d8',fontSize:13}}>{services[service]?.note || ''}</div>
                <div style={{marginTop:10}}>
                  <button
                    style={styles.btnSecondary}
                    onClick={() => openService(service)}
                    disabled={(service==='chatgpt' && loading.openChat) || (service==='flow' && loading.openFlow) || (service==='grok' && loading.openGrok)}
                  >
                    {((service==='chatgpt' && loading.openChat) || (service==='flow' && loading.openFlow) || (service==='grok' && loading.openGrok)) ? <Spinner /> : null}
                    {service === 'chatgpt' ? 'Logar ChatGPT' : service === 'flow' ? 'Logar Flow' : 'Logar Grok'}
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div style={styles.stepWrap}>
            {[
              ['chatgpt','ChatGPT'],
              ['images','Criação de imagens'],
              ['videos','Criação dos vídeos'],
              ['download','Baixar'],
            ].map(([key,label], idx) => (
              <div key={String(key)} style={{...styles.stepCard, ...(step === key ? styles.stepActive : {}), ...(!stepEnabled[key as StepKey] ? styles.stepLocked : {})}} onClick={() => trySetStep(key as StepKey)}>
                <div style={{ width:28, height:28, borderRadius:999, display:'grid', placeItems:'center', background:'rgba(255,255,255,0.08)', fontWeight:700, fontSize:12, marginBottom:10 }}>{idx+1}</div>
                <div style={{ fontWeight:800 }}>{String(label)}</div>
                {!stepEnabled[key as StepKey] ? <div style={{ color:'#7f8c9d', marginTop:6, fontSize:12 }}>Bloqueado</div> : null}
              </div>
            ))}
          </div>

          {step === 'chatgpt' ? (
            <>
              <div style={styles.content}>
                <section style={styles.panel}>
                  <div style={styles.panelTitle}>Etapa 1 · ChatGPT</div>
                  <div style={styles.row3}>
                    <button style={styles.btnPrimary} onClick={loadAgents} disabled={loading.agents}>
                      {loading.agents ? <Spinner /> : null}Identificar GPTs criados
                    </button>
                    <button style={styles.btnSecondary} onClick={refreshConversation} disabled={loading.history}>
                      {loading.history ? <Spinner /> : null}Atualizar histórico
                    </button>
                    <button style={styles.btnSecondary} onClick={() => openService('chatgpt')} disabled={loading.openChat}>
                      {loading.openChat ? <Spinner /> : null}Acessar conversa
                    </button>
                  </div>

                  <div style={{ marginTop: 16 }}>
                    <label style={styles.label}>GPT/agente selecionado</label>
                    <select style={styles.input} value={selectedAgentId} onChange={(e) => setSelectedAgentId(e.target.value)}>
                      <option value="">Selecione</option>
                      {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
                    </select>
                  </div>

                  <div style={{ marginTop: 16, ...styles.row2 }}>
                    <button style={ideaMode === 'direct' ? styles.btnPrimary : styles.btnSecondary} onClick={() => setIdeaMode('direct')}>Chat comum</button>
                    <button style={ideaMode === 'ideas' ? styles.btnPrimary : styles.btnSecondary} onClick={() => setIdeaMode('ideas')}>Pedir ideias</button>
                  </div>

                  {ideaMode === 'direct' ? (
                    <div style={{ marginTop: 16 }}>
                      <label style={styles.label}>Mensagem</label>
                      <textarea style={styles.textarea} value={directMessage} onChange={(e) => setDirectMessage(e.target.value)} />
                    </div>
                  ) : (
                    <div style={{ marginTop: 16 }}>
                      <div style={styles.row2}>
                        <div>
                          <label style={styles.label}>Assunto</label>
                          <input style={styles.input} value={ideasSubject} onChange={(e) => setIdeasSubject(e.target.value)} />
                        </div>
                        <div>
                          <label style={styles.label}>Quantidade de ideias</label>
                          <input type="number" style={styles.input} value={ideasCount} onChange={(e) => setIdeasCount(Number(e.target.value || 10))} />
                        </div>
                      </div>
                      <div style={{ marginTop: 12 }}>
                        <label style={styles.label}>Instruções extras</label>
                        <textarea style={styles.textarea} value={ideasExtra} onChange={(e) => setIdeasExtra(e.target.value)} />
                      </div>
                    </div>
                  )}

                  <div style={{ marginTop: 16 }}>
                    <button style={styles.btnPrimary} onClick={send} disabled={!selectedAgentId || sending || loading.send}>
                      {(sending || loading.send) ? <Spinner /> : null}Enviar mensagem
                    </button>
                  </div>

                  {sendNotice ? <div style={styles.toastOk}>{sendNotice}</div> : null}
                  {sendError ? <div style={styles.toastErr}>{sendError}</div> : null}
                </section>

                <section style={styles.panel}>
                  <div style={styles.panelTitle}>Estrutura do projeto</div>
                  <details><summary style={{ cursor:'pointer', fontWeight:800 }}>Título</summary><div style={{ marginTop:10, ...styles.statusBox }}>{parsed.title || '—'}</div></details>
                  <div style={{ height: 10 }} />
                  <details><summary style={{ cursor:'pointer', fontWeight:800 }}>Tema</summary><div style={{ marginTop:10, ...styles.statusBox }}>{parsed.theme || '—'}</div></details>
                  <div style={{ height: 10 }} />
                  <details><summary style={{ cursor:'pointer', fontWeight:800 }}>História</summary><div style={{ marginTop:10, ...styles.statusBox }}>{parsed.story || '—'}</div></details>
                  <div style={{ height: 10 }} />
                  <details>
                    <summary style={{ cursor:'pointer', fontWeight:800 }}>Personagens</summary>
                    <div style={{ marginTop:10, display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(220px, 1fr))', gap:12 }}>
                      {parsed.characterCards?.length ? parsed.characterCards.map((card, idx) => (
                        <div key={idx} style={styles.charCard}>{card}</div>
                      )) : <div style={styles.statusBox}>—</div>}
                    </div>
                  </details>
                  <div style={{ height: 10 }} />
                  <details><summary style={{ cursor:'pointer', fontWeight:800 }}>Prompt da capa</summary><div style={{ marginTop:10, ...styles.statusBox }}>{parsed.coverPrompt || '—'}</div></details>
                  <div style={{ height: 10 }} />
                  <div>
                    <div style={{ fontWeight: 800, marginBottom: 10 }}>Cenas</div>
                    {parsed.scenes?.length ? (
                      <div style={styles.sceneGrid}>
                        {parsed.scenes.map((scene) => (
                          <div key={scene.number} style={styles.sceneCard}>
                            <div><b>Cena {scene.number}</b></div>
                            <button style={styles.helperBtn} onClick={() => setSceneDetail(scene)}>?</button>
                          </div>
                        ))}
                      </div>
                    ) : <div style={styles.statusBox}>Nenhuma cena identificada ainda.</div>}
                  </div>
                </section>
              </div>

              <div style={{ marginTop: 18 }}>
                <details style={styles.panel}>
                  <summary style={{ cursor: 'pointer', fontWeight: 800 }}>Resposta bruta do chat</summary>
                  <div style={{ marginTop: 12 }}>
                    <div style={styles.promptBox}>{raw || 'Ainda vazio.'}</div>
                  </div>
                </details>
              </div>
            </>
          ) : step === 'images' ? (
            <div style={{ marginTop: 20 }}>
              <div style={styles.panel}>
                <div style={styles.panelTitle}>Etapa 2 · Criação de imagens</div>
                <div style={styles.row3}>
                  <select style={styles.input} value={imageSettings.orientation} onChange={(e)=>setImageSettings(s=>({...s, orientation:e.target.value}))}>
                    <option value="16:9">16:9</option>
                    <option value="4:3">4:3</option>
                    <option value="1:1">1:1</option>
                    <option value="3:4">3:4</option>
                    <option value="9:16">9:16</option>
                  </select>
                  <select style={styles.input} value={String(imageSettings.perScene)} onChange={(e)=>setImageSettings(s=>({...s, perScene:Number(e.target.value)}))}>
                    <option value="1">1 imagem</option>
                    <option value="2">2 imagens</option>
                    <option value="3">3 imagens</option>
                    <option value="4">4 imagens</option>
                  </select>
                  <select style={styles.input} value={imageSettings.model} onChange={(e)=>setImageSettings(s=>({...s, model:e.target.value}))}>
                    <option value="Nano Banana Pro">Nano Banana Pro</option>
                    <option value="Nano Banana 2">Nano Banana 2</option>
                    <option value="Imagem 4">Imagem 4</option>
                  </select>
                </div>
                <div style={{ ...styles.row3, marginTop: 14 }}>
                  <button style={styles.btnPrimary} onClick={startImages} disabled={!parsed.scenes?.length || loading.startImages}>
                    {loading.startImages ? <Spinner /> : null}Start
                  </button>
                  <button style={styles.btnSecondary} onClick={() => openService('flow')} disabled={loading.openFlow}>
                    {loading.openFlow ? <Spinner /> : null}Abrir Flow
                  </button>
                  <button style={styles.btnSecondary} onClick={openNewProjectOnly} disabled={loading.openNewProject}>
                    {loading.openNewProject ? <Spinner /> : null}Testar Novo projeto
                  </button>
                </div>
                <div style={{ ...styles.row2, marginTop: 12 }}>
                  <button style={styles.btnSecondary} onClick={testFlowModelMenu536} disabled={loading.testModelMenu536}>
                    {loading.testModelMenu536 ? <Spinner /> : null}TESTAR MENU MODELO V5.3.6-FORCED-FINAL-UNIQUE
                  </button>
                  <div style={styles.statusBox}>Escolha a proporção no seletor acima. Depois use 'Testar quantidade'. Esta versão abre chip, marca Imagem e tenta selecionar a proporção.</div>
                </div>
                <div style={{ ...styles.row2, marginTop: 12 }}>
                  <button style={styles.btnSuccess} onClick={approveAllImages} disabled={!images.some(x=>x.url) || loading.approveAllImages}>
                    {loading.approveAllImages ? <Spinner /> : null}Aprovar todas as imagens
                  </button>
                  <div style={styles.statusBox}>Use primeiro 'Testar Novo projeto'. Depois use 'Testar quantidade'.</div>
                </div>
                {imageNotice ? <div style={styles.toastOk}>{imageNotice}</div> : null}

                {parsed.scenes.map(scene => {
                  const slots = [...(sceneImageMap[scene.number] || [])].sort((a,b)=>a.variant-b.variant)
                  return (
                    <div key={scene.number} style={{ ...styles.mediaCard, marginTop: 16 }}>
                      <div style={styles.mediaMeta}>
                        <div style={{ fontWeight: 800 }}>Cena {scene.number}</div>
                        <div style={{ color:'#94a3b8', marginTop:6 }}>Orientação: {imageSettings.orientation} · Quantidade: {imageSettings.perScene} · Modelo: {imageSettings.model}</div>
                        <div style={{ marginTop:8, ...styles.promptBox }}>{scene.imagePrompt || 'Sem prompt de imagem identificado.'}</div>
                      </div>
                      <div style={styles.mediaActions}>
                        <button style={styles.btnSecondary} onClick={() => navigator.clipboard.writeText(scene.imagePrompt || '')}>Copiar prompt da cena</button>
                        <button style={styles.btnSecondary} onClick={() => openService('flow')} disabled={loading.openFlow}>
                          {loading.openFlow ? <Spinner /> : null}Abrir Flow
                        </button>
                      </div>
                      <div style={{ padding:'0 12px 12px' }}>
                        <div style={styles.sceneGrid}>
                          {Array.from({length:imageSettings.perScene}).map((_, idx) => {
                            const variant = idx + 1
                            const id = `${scene.number}-${variant}`
                            const slot = slots.find(s => s.id === id)
                            return (
                              <div key={id} style={{ border:'1px solid rgba(255,255,255,0.08)', borderRadius:14, overflow:'hidden', background:'#091018' }}>
                                <div style={{ minHeight:220, display:'grid', placeItems:'center' }}>
                                  {slot?.url ? <img src={slot.url} alt={`Cena ${scene.number} imagem ${variant}`} style={{ width:'100%', display:'block', objectFit:'cover' }} /> : <div style={{ padding:16, color:'#93a4b8', textAlign:'center' }}>Cena {scene.number} · Imagem {variant}</div>}
                                </div>
                                <div style={{ padding:12 }}>
                                  <div style={{ fontWeight:700 }}>Imagem {variant}</div>
                                  <div style={{ marginTop:4, color:'#93a4b8' }}>{slot ? slot.status : 'pendente'}</div>
                                  {slot?.note ? <div style={{ marginTop:4, color:'#93a4b8', fontSize:12 }}>{slot.note}</div> : null}
                                  {typeof slot?.progress === 'number' ? (
                                    <div style={styles.progressWrap}>
                                      <div style={{ height:'100%', width:`${slot.progress}%`, background:'linear-gradient(90deg,#2c9cff,#22c55e)' }} />
                                    </div>
                                  ) : null}
                                </div>
                                <div style={styles.mediaActions}>
                                  <button style={styles.btnWarn} onClick={() => retryImage(id)} disabled={slot?.status === 'locked'}>↻ Refazer</button>
                                  <button style={styles.btnSecondary} onClick={() => imageFileRefs.current[id]?.click()} disabled={slot?.status === 'locked'}>Enviar imagem</button>
                                  <input type="file" accept="image/*" style={styles.fileInput} ref={(el)=>{imageFileRefs.current[id]=el}} onChange={(e)=>handleUploadImage(id, e.target.files?.[0] || null)} />
                                  <button style={styles.btnSuccess} disabled={slot?.status !== 'uploaded'} onClick={() => approveImage(id)}>Aprovar</button>
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    </div>
                  )
                })}
                {imagesCompleted ? <div style={styles.toastOk}>Todas as imagens foram aprovadas. A etapa de vídeos foi liberada.</div> : null}
              </div>
            </div>
          ) : step === 'videos' ? (
            <div style={{ marginTop: 20 }}>
              <div style={styles.panel}>
                <div style={styles.panelTitle}>Etapa 3 · Criação dos vídeos</div>
                <div style={{ ...styles.row2, marginTop: 14 }}>
                  <button style={styles.btnPrimary} onClick={startVideos} disabled={!imagesCompleted || loading.startVideos}>
                    {loading.startVideos ? <Spinner /> : null}Start
                  </button>
                  <button style={styles.btnSecondary} onClick={() => openService('grok')} disabled={loading.openGrok}>
                    {loading.openGrok ? <Spinner /> : null}Abrir Grok
                  </button>
                </div>
                {videoNotice ? <div style={styles.toastOk}>{videoNotice}</div> : null}

                {videos.length ? (
                  <div style={{ ...styles.mediaGrid, marginTop: 18 }}>
                    {videos.map((video) => (
                      <div key={video.sceneNumber} style={styles.mediaCard}>
                        <div style={{ minHeight: 360, background: '#091018', display:'grid', placeItems:'center' }}>
                          {video.url ? <video src={video.url} controls style={{ width:'100%' }} /> : <div style={{ padding: 20, textAlign:'center', color:'#93a4b8' }}>Sem vídeo enviado</div>}
                        </div>
                        <div style={styles.mediaMeta}>
                          <div style={{ fontWeight: 800 }}>Cena {video.sceneNumber}</div>
                          <div style={{ color: '#7f8c9d', marginTop: 4 }}>{video.status}</div>
                          {video.note ? <div style={{ marginTop:4, color:'#93a4b8', fontSize:12 }}>{video.note}</div> : null}
                        </div>
                        <div style={styles.mediaActions}>
                          <button style={styles.btnSecondary} onClick={() => navigator.clipboard.writeText(video.prompt || '')}>Copiar prompt</button>
                          <button style={styles.btnSecondary} onClick={() => openService('grok')} disabled={loading.openGrok}>
                            {loading.openGrok ? <Spinner /> : null}Abrir Grok
                          </button>
                          <button style={styles.btnWarn} onClick={() => retryVideo(video.sceneNumber)}>↻ Refazer</button>
                          <button style={styles.btnSecondary} onClick={() => videoFileRefs.current[video.sceneNumber]?.click()}>Enviar vídeo</button>
                          <input type="file" accept="video/*" style={styles.fileInput} ref={(el)=>{videoFileRefs.current[video.sceneNumber]=el}} onChange={(e)=>handleUploadVideo(video.sceneNumber, e.target.files?.[0] || null)} />
                          <button style={styles.btnSuccess} disabled={video.status !== 'uploaded'} onClick={() => approveVideo(video.sceneNumber)}>Aprovar</button>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
                {videosCompleted ? <div style={styles.toastOk}>Todos os vídeos foram aprovados. A etapa de download foi liberada.</div> : null}
              </div>
            </div>
          ) : (
            <div style={{ marginTop: 20 }}>
              <div style={styles.panel}>
                <div style={styles.panelTitle}>Etapa 4 · Baixar</div>
                <div style={{ ...styles.row3, marginTop: 14 }}>
                  <button style={styles.btnPrimary} onClick={exportPrompts}>Baixar prompts</button>
                  <button style={styles.btnSecondary} onClick={exportImagesZip}>Baixar imagens ZIP</button>
                  <button style={styles.btnSecondary} onClick={exportVideosZip}>Baixar vídeos ZIP</button>
                </div>
                {downloadNotice ? <div style={styles.toastOk}>{downloadNotice}</div> : null}
              </div>
            </div>
          )}

          {sceneDetail ? (
            <div style={styles.modalBackdrop} onClick={() => setSceneDetail(null)}>
              <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', gap:12 }}>
                  <div style={{ fontSize: 22, fontWeight: 800 }}>Cena {sceneDetail.number}</div>
                  <button style={styles.btnSecondary} onClick={() => setSceneDetail(null)}>Fechar</button>
                </div>
                {sceneDetail.type ? <div style={{ marginTop: 14 }}><b>Tipo:</b> {sceneDetail.type}</div> : null}
                {sceneDetail.voiceover ? <div style={{ marginTop: 10 }}><b>Locução:</b> {sceneDetail.voiceover}</div> : null}
                <div style={{ marginTop: 14 }}>
                  <b>Prompt da cena / imagem (Flow)</b>
                  <div style={styles.promptBox}>{sceneDetail.imagePrompt || 'Não identificado.'}</div>
                </div>
                <div style={{ marginTop: 14 }}>
                  <b>Prompt do vídeo (Grok)</b>
                  <div style={styles.promptBox}>{sceneDetail.videoPrompt || 'Não identificado.'}</div>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
