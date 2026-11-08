# Melissa IPTV

Servidor IPTV que extrai vídeos de um álbum público do Google Fotos e os entrega em HLS usando FFmpeg.

## Como funciona

1. `start.js` inicia a aplicação e chama o extrator.
2. `extractor.js` usa `@marcus5914/google-photos-album-image-url-fetch` para buscar todas as mídias do álbum e montar o catálogo JSON.
3. Ao solicitar um canal/vídeo pela primeira vez, `hls.js` executa FFmpeg diretamente sobre a URL do Google Fotos.
4. FFmpeg gera uma playlist HLS VOD (`.m3u8`) e segmentos MPEG-TS (`.ts`) em armazenamento temporário.
5. `server.js` entrega a playlist IPTV e os segmentos pelo domínio público.

A geração usa `-c copy` para evitar recodificação e reduzir uso de CPU. Isso depende de os codecs do vídeo serem compatíveis com o contêiner MPEG-TS e com o player. O servidor gera um vídeo HLS por vez e mantém somente o último no cache para respeitar o espaço temporário limitado.

## Hostless

Configure como **App** com:

- Build system: Detect automatically
- Build command: `npm install`
- Start command: `npm start`
- Health check path: `/health`
- Node.js: versão 24 LTS (o arquivo `.nvmrc` fixa a linha 24)
- Sem volume persistente obrigatório: catálogo e HLS são recriados a cada inicialização em `/tmp`.

O pacote `ffmpeg-static` baixa o binário FFmpeg adequado durante a instalação das dependências. Não é necessário instalar FFmpeg manualmente no comando de inicialização.

O Hostless mantém o sistema raiz somente leitura. Por isso, os dados temporários ficam em `/tmp/melissa-iptv`. O cache HLS tem limite padrão de 400 MiB para deixar margem dentro do limite de 500 MiB de `/tmp`.

## Endereços

- Página/estado: `/`
- Saúde: `/health`
- Playlist IPTV: `/playlist.m3u8`
- Playlist alternativa: `/playlist.m3u`
- Catálogo JSON: `/api/videos`
- Playlist HLS individual: `/hls/:id/index.m3u8`
- Segmentos: `/hls/:id/segment_00000.ts`

Endereço público padrão: https://melissa-iptv.hostless.app

## Variáveis opcionais

Veja `.env.example`. As principais são `PHOTOS_ALBUM_URL`, `PUBLIC_URL`, `IPTV_TOKEN`, `HLS_SEGMENT_SECONDS`, `MAX_HLS_BYTES` e `HLS_TIMEOUT_MS`.

## Execução local

```bash
npm install
npm start
```

## Observações

- O álbum do Google Fotos precisa estar compartilhado publicamente.
- A ferramenta de extração retorna URLs temporárias do Google Fotos; o catálogo é reconstruído ao iniciar.
- A primeira abertura de cada vídeo aguarda a geração completa do HLS VOD. Depois, o player pode buscar segmentos individualmente e retomar a reprodução usando a playlist.
- A troca para outro vídeo substitui o cache anterior.
- Não há transcodificação por padrão. Vídeos com codecs não aceitos pelo player podem precisar de uma futura opção de conversão, que consumirá mais CPU e espaço.
