# Melissa IPTV Relay

Relay HTTP de bytes. O Hostless recebe um fluxo em `/enviar/:id` e repassa o mesmo conteúdo para quem estiver conectado em `/receber/:id`.

O relay não interpreta vídeo, HLS, playlists ou segmentos.

## Rotas

- `POST /enviar/:id`: recebe o fluxo. Exige `Authorization: Bearer TOKEN`.
- `GET /receber/:id`: recebe o mesmo fluxo. A conexão espera até o remetente chegar.
- `GET /health`: verifica se o processo está ativo.

Um remetente e um receptor por identificador. O fluxo usa memória temporária e backpressure do Node.js. Quando um lado desconecta antes do fim, o outro lado também é encerrado.

## Hostless

Configure as variáveis:

```env
PORT=18080
TUNNEL_TOKEN=um-token-grande-e-privado
```

Instale e inicie:

```bash
npm install
npm start
```

## Termux

Configure:

```env
SOURCE_URL=http://127.0.0.1:8000/video1
RELAY_URL=https://SEU_HOSTLESS
STREAM_ID=video1
TUNNEL_TOKEN=O_MESMO_TOKEN_DO_HOSTLESS
```

Inicie o envio:

```bash
npm run client
```

O cliente lê a resposta da origem local e transmite os bytes ao Hostless sem interpretar o conteúdo.

## Player

Use o endereço:

```
https://SEU_HOSTLESS/receber/video1
```

O identificador precisa ser igual ao `STREAM_ID` usado pelo Termux.

## Limitações desta primeira versão

- Um remetente e um receptor simultâneos por identificador.
- O fluxo não fica armazenado permanentemente.
- O receptor precisa permanecer conectado durante a transmissão.
- O Hostless não implementa cache, autenticação do player, Range ou retomada de transferência.
