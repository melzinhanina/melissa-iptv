# Melissa IPTV

Servidor IPTV que extrai vídeos de um álbum público do Google Fotos e gera HLS progressivamente, sem baixar o vídeo inteiro antes da reprodução.

## Arquitetura

1. `start.js` atualiza o catálogo com o extrator do Google Fotos.
2. O servidor abre a URL de vídeo do Google Fotos, que responde HTTP 200.
3. O corpo da resposta é lido em blocos pequenos e enviado ao stdin do FFmpeg.
4. O FFmpeg usa `-c copy` e gera segmentos HLS sem recodificar o vídeo.
5. O servidor mantém uma janela curta de segmentos por vídeo e só continua lendo a origem quando o player avança e pede mais conteúdo.
6. Vários vídeos podem manter sessões e pequenos caches independentes ao mesmo tempo.

## Importante sobre HTTP

- Google Fotos -> servidor: HTTP 200 em fluxo sequencial.
- Servidor -> player: playlist HLS responde HTTP 200. Segmentos TS respondem HTTP 200 quando pedidos inteiros e HTTP 206 real quando o player envia um cabeçalho Range válido, com Content-Range e Accept-Ranges.
- HTTP 206 é aplicado aos bytes do segmento TS solicitado. A playlist HLS continua sendo HTTP 200.

O controle de entrada é baseado na janela de segmentos: o servidor mantém poucos segmentos à frente do último segmento solicitado pelo player. A leitura da origem pausa quando essa janela está cheia e retoma conforme o player avança. Isso limita o pré-carregamento, embora a rede e os buffers internos do sistema ainda possam absorver pequenas quantidades adicionais.

## Cache e limites

- HLS segmentado em 6 segundos por padrão.
- Playlist deslizante com 8 segmentos por padrão.
- Pré-carregamento de 2 segmentos além do avanço do player.
- Não há limite fixo de sessões HLS simultâneas; sessões ociosas continuam sendo removidas após o TTL configurado.
- Arquivos temporários em `/tmp/melissa-iptv/hls`.
- FFmpeg usa `-c copy`: não há recodificação pesada.
- O cache é temporário e pode ser apagado quando o app reiniciar.

## Hostless

Configure como **App**:
- Build command: `npm install`
- Start command: `npm start`
- Health check: `/health`
- Node.js 24 LTS.

O sistema raiz do Hostless é somente leitura. O projeto grava somente em `/tmp`.

## Endpoints

- `/health`
- `/playlist.m3u8`
- `/playlist.m3u`
- `/api/videos`
- `/hls/:id/index.m3u8`
- `/hls/:id/segment_00000.ts`

## Variáveis

- `PHOTOS_ALBUM_URL`: álbum público do Google Fotos.
- `PUBLIC_URL`: endereço público do app.
- `IPTV_TOKEN`: token opcional.
- `DATA_DIR`: diretório temporário do catálogo.
- `HLS_DIR`: diretório temporário dos segmentos.
- `HLS_SEGMENT_SECONDS`: duração-alvo dos segmentos (2 a 15 segundos).
- `HLS_LIST_SIZE`: quantidade de segmentos na playlist.
- `HLS_PREFETCH_SEGMENTS`: segmentos de avanço mantidos no buffer.
- `HLS_SESSION_TTL_MS`: retenção de sessões ociosas.

## Execução

```bash
npm install
npm start
```
