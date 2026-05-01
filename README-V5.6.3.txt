DARKPLANNER V5.6.3-BEST-REFERENCE-HYBRID

Esta versão combina o melhor das duas linhas:

Base do Claude:
- fluxo completo com /project/create
- pausa entre cenas aguardando aprovação
- salvamento automático das imagens geradas
- upload da imagem aprovada como referência
- exclusão/tentativa de exclusão das reprovadas

Correções desta linha:
- package/version corrigidos para 5.6.3
- npm run setup preservado
- scripts FECHAR_PORTAS.ps1 e RODAR_LIMPO.ps1
- /project/create não depende mais de caminho fixo; usa a pasta do projeto se basePath vier vazio
- projectImgDirRef evita falha de state assíncrono no approveImage
- aprovação salva usando slot.url OU slot.flowUrl
- upload pelo botão + ganhou fallback genérico além do add_2Criar
- refresh do ChatGPT ajustado para 5 segundos

Uso:
Primeira vez nessa pasta:
npm run setup

Depois:
npm run dev

Se porta ocupada:
.\RODAR_LIMPO.ps1
