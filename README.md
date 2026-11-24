# Melissa IPTV Relay + Cache

Servidor HTTP no Hostless com duas funções independentes:

1. **Tunnel:** encaminha um fluxo contínuo do Termux para o player.
2. **Cache IPTV:** recebe segmentos individuais, mantém os bytes em RAM e os entrega com suporte a HTTP Range.

## Tunnel (preservado)

- `POST /enviar/:id`: envia um fluxo ao relay.
- `GET /receber/:id`: recebe o mesmo fluxo.
- `GET /health`: verifica se o processo está ativo.

Um remetente e um receptor simultâneos por identificador. O relay usa memória temporária e backpressure do Node.js. Quando um lado desconecta antes do fim, o outro lado também é encerrado. O tunnel não é armazenado no cache.

Player do tunnel:

```
https://melissa-iptv.hostless.app/receber/video1
```

## Cache de segmentos IPTV

O cache usa identificadores de stream e segmento na URL. Não grava arquivos no disco.

### Enviar ou atualizar um segmento

```http
POST /cache/:stream/:segment
Content-Type: video/mp2t
X-Cache-TTL: 600

<bytes do segmento>
```

Exemplo com cURL:

```bash
curl -X POST \
  -H "Content-Type: video/mp2t" \
  --data-binary @segment0001.ts \
  https://melissa-iptv.hostless.app/cache/canal1/segment0001.ts
```

O cabeçalho opcional `X-Cache-TTL` define a validade em segundos. O padrão é 600 segundos (10 minutos), com máximo de 3600 segundos (1 hora).

### Buscar um segmento

```
GET /cache/:stream/:segment
HEAD /cache/:stream/:segment
```

A resposta inclui `ETag`, `Accept-Ranges: bytes` e `X-Cache-Status: HIT`. Requisições com `Range: bytes=...` recebem `206 Partial Content`; intervalos inválidos recebem `416 Range Not Satisfiable`.

### Listar segmentos de um stream

```
GET /cache/:stream
```

Retorna JSON com os segmentos ainda válidos, tamanho e expiração.

### Remover um segmento

```
DELETE /cache/:stream/:segment
```

## Limites de memória

Valores padrão:

- Cache total: 512 MiB.
- Tamanho máximo por segmento: 16 MiB.
- Validade padrão: 10 minutos.
- Validade máxima por segmento: 1 hora.
- Ao atingir a capacidade, segmentos menos recentemente acessados são removidos (LRU).
- Segmentos expirados são removidos quando o cache é consultado ou recebe novos dados.

É possível ajustar os limites por variáveis de ambiente:

- `CACHE_MAX_BYTES`
- `CACHE_MAX_SEGMENT_BYTES`
- `CACHE_TTL_MS`

O cache é volátil: reiniciar o processo limpa os segmentos. As rotas são públicas, portanto não envie conteúdo privado ou identificadores sensíveis.

## Tunnel HTTP reverso automático

O Termux mantém uma conexão de polling com este relay, sem exigir senha ou token. Quando o player abre uma URL em `/iptv/...`, o Hostless encaminha a requisição ao Termux e devolve a resposta ao player. Isso permite publicar a própria playlist, os manifests HLS e também requisições HTTP Range sem expor o IP local do Termux.

URL pública da playlist HLS:

```
https://melissa-iptv.hostless.app/iptv/playlist-hls.m3u8
```

Não há configuração de senha, token ou código. O agente do Termux inicia automaticamente e o player usa somente a URL pública. As rotas de agente são endpoints técnicos públicos e devem ser usadas apenas neste serviço.

O agente reverso é iniciado automaticamente pelo `npm start` do servidor Termux. Não é necessário executar o cliente de tunnel antigo. As rotas `/enviar/:id` e `/receber/:id` continuam disponíveis para o fluxo linear legado.

## Inicialização no Hostless

A porta usa a variável `PORT` da plataforma:

```bash
npm install
npm start
```

## Termux

O `client.mjs` continua com a função antiga de enviar o fluxo local ao tunnel. O cache é uma API adicional para o servidor IPTV/gerador HLS enviar cada segmento individualmente. O cliente de segmentos deve publicar os segmentos na rota `/cache/:stream/:segment` e o player deve consumir essas mesmas URLs.

## Importante

O cache de segmentos não intercepta automaticamente o fluxo contínuo do tunnel. Para o IPTV aproveitar o cache, o produtor HLS precisa enviar os segmentos pela API de cache e a playlist precisa apontar para as rotas `/cache/...`. Essa separação mantém o relay antigo funcionando sem alterar seu comportamento.
