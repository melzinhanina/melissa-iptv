# Melissa IPTV

Servidor IPTV que extrai vídeos de um álbum público do Google Fotos e os entrega por streaming progressivo com suporte a HTTP Range.

## Arquitetura

1. `start.js` atualiza o catálogo usando o extrator do Google Fotos.
2. O Google Fotos entrega a origem com HTTP 200.
3. `range-stream.js` lê a origem sob demanda, com backpressure e um buffer circular pequeno por vídeo.
4. O player solicita intervalos de bytes com o cabeçalho `Range`.
5. O Melissa IPTV responde HTTP 206 com `Content-Range`, `Content-Length` e `Accept-Ranges: bytes`.

A entrada não é acelerada sem limite: o leitor pausa quando o buffer de avanço está cheio e volta a ler conforme o player consome os bytes. Vários vídeos podem manter pequenos buffers simultaneamente.

## Limitações importantes

- A origem precisa informar um `Content-Length` válido. Sem o tamanho total, não é possível montar um `Content-Range` confiável.
- A origem do Google Fotos é sequencial (HTTP 200), portanto não oferece busca aleatória real. Se o player pedir um intervalo que já saiu do cache enquanto outro player ainda usa o mesmo vídeo, o servidor responde 416 em vez de inventar dados.
- Quando não há outro player usando o vídeo, uma solicitação antiga pode reiniciar a leitura da origem desde o começo.
- O buffer padrão é 2 MiB por vídeo ativo, configurável por `RANGE_BUFFER_BYTES`. O limite padrão é 12 vídeos ativos.
- Uma requisição sem cabeçalho Range recebe HTTP 200 normal. Requisições com Range válido recebem HTTP 206. Esse é o comportamento HTTP correto.
- A entrega é do arquivo original, sem FFmpeg nem recodificação. Compatibilidade de codecs depende do player.

## Hostless

Configure como **App** com:

- Build command: `npm install`
- Start command: `npm start`
- Health check path: `/health`
- Node.js 24 LTS (o arquivo `.nvmrc` fixa a linha 24)

O sistema raiz do Hostless é somente leitura. O catálogo temporário continua em `/tmp/melissa-iptv`; os buffers dos vídeos ficam na RAM e não precisam de arquivos temporários.

## Endereços

- Saúde: `/health`
- Playlist IPTV: `/playlist.m3u8`
- Playlist alternativa: `/playlist.m3u`
- Catálogo JSON: `/api/videos`
- Vídeo com suporte a Range: `/stream/:id`

Endereço público padrão: https://melissa-iptv.hostless.app

## Variáveis

- `PHOTOS_ALBUM_URL`: álbum público do Google Fotos.
- `PUBLIC_URL`: endereço público do app.
- `IPTV_TOKEN`: token opcional de acesso.
- `DATA_DIR`: diretório temporário gravável.
- `RANGE_BUFFER_BYTES`: buffer máximo de avanço por vídeo ativo (padrão 2 MiB).
- `MAX_ACTIVE_STREAMS`: máximo de vídeos com leitores ativos (padrão 12).
- `RANGE_STATE_TTL_MS`: tempo de retenção de estado inativo (padrão 10 minutos).

## Execução local

```bash
npm install
npm start
```
