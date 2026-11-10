# Melissa IPTV

Servidor IPTV que extrai vídeos de um álbum público do Google Fotos e entrega HLS VOD com geração de segmentos sob demanda.

## Arquitetura

1. `start.js` atualiza o catálogo com o extrator do Google Fotos.
2. O servidor consulta a duração do vídeo diretamente na URL pública do Google Fotos usando FFmpeg.
3. A playlist HLS VOD é montada com a duração completa do vídeo.
4. Cada segmento TS é gerado somente quando o player o solicita.
5. Para gerar um segmento, o FFmpeg abre a URL original e aplica seek de entrada para buscar o trecho correspondente, em vez de receber o vídeo por `pipe:0`.
6. Os segmentos gerados ficam em cache em `/tmp/melissa-iptv/hls` durante a sessão. Se a sessão expirar, o trecho pode ser gerado novamente quando solicitado.

## Seek e acesso HTTP

- A playlist é VOD e lista os segmentos do vídeo inteiro.
- O player pode solicitar segmentos de qualquer posição, inclusive trechos que ainda não foram gerados.
- O servidor gera o segmento solicitado a partir da URL original do Google Fotos e guarda o resultado em cache.
- O seek depende de a origem do Google Fotos permitir que o FFmpeg faça acesso por posição (HTTP Range). Se a origem não oferecer esse recurso para determinado vídeo, a busca poderá ficar lenta ou falhar.
- Segmentos TS aceitam cabeçalho Range e respondem HTTP 206 quando o intervalo solicitado é válido. A playlist HLS responde HTTP 200.

## Cache e limites

- HLS segmentado em 6 segundos por padrão.
- Os segmentos são gerados sob demanda, não é necessário baixar o vídeo inteiro antes de iniciar a reprodução.
- Segmentos gerados permanecem em `/tmp/melissa-iptv/hls` enquanto a sessão estiver ativa.
- Sessões ociosas são removidas após o TTL configurado.
- FFmpeg usa `-c copy`, sem recodificação de vídeo.
- O cache é temporário e pode ser apagado quando o app reiniciar.

## Hostless

Configure como **App**:
- Build command: `npm install`
- Start command: `npm start`
- Health check: `/health`
- Node.js 24 LTS.

O sistema raiz do Hostless pode ser somente leitura. O projeto grava somente em `/tmp`.

## Endpoints

- `/health`
- `/playlist.m3u8`
- `/playlist.m3u`
- `/api/videos`
- `/hls/:id/index.m3u8`
- `/hls/:id/segment_00000.ts`

## Configuração

- O link do álbum público do Google Fotos fica diretamente no código em `start.js`.
- A lista de vídeos é renovada automaticamente a cada 5 minutos.
- `PUBLIC_URL`: endereço público do app (opcional).
- `IPTV_TOKEN`: token opcional para proteção dos endpoints, se habilitado.
- `DATA_DIR`: diretório temporário do catálogo.
- `HLS_DIR`: diretório temporário dos segmentos.
- `HLS_SEGMENT_SECONDS`: duração-alvo dos segmentos (2 a 15 segundos).
- `HLS_SESSION_TTL_MS`: retenção de sessões ociosas.

## Execução

```bash
npm install
npm start
```
