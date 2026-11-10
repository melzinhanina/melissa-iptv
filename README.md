# Melissa IPTV Relay

Relay HTTP público de bytes. O Hostless recebe um fluxo em `/enviar/:id` e repassa o mesmo conteúdo para quem estiver conectado em `/receber/:id`.

O relay não interpreta vídeo, HLS, playlists ou segmentos. Nenhuma das rotas exige senha ou token.

## Rotas

- `POST /enviar/:id`: envia um fluxo ao relay.
- `GET /receber/:id`: recebe o mesmo fluxo.
- `GET /health`: verifica se o processo está ativo.

Um remetente e um receptor por identificador. O fluxo usa memória temporária e backpressure do Node.js. Quando um lado desconecta antes do fim, o outro lado também é encerrado.

## Hostless

O servidor usa a porta fornecida pela plataforma Hostless (`PORT`). Não precisa de arquivo de configuração.

Inicie com:

```bash
npm install
npm start
```

## Termux

As configurações do cliente ficam diretamente no início de `client.mjs`:

- `SOURCE_URL`: endereço da origem local.
- `RELAY_URL`: endereço público do relay.
- `STREAM_ID`: identificador do fluxo.

Edite esses valores no próprio arquivo e inicie:

```bash
npm run client
```

O cliente lê a resposta da origem local e transmite os bytes ao Hostless sem interpretar o conteúdo.

## Player

```
https://melissa-iptv.hostless.app/receber/video1
```

O identificador precisa ser igual ao `STREAM_ID` usado pelo Termux.

## Limitações

- As rotas são públicas, inclusive o envio.
- Um remetente e um receptor simultâneos por identificador.
- O fluxo não fica armazenado permanentemente.
- O receptor precisa permanecer conectado durante a transmissão.
- Não implementa cache, Range ou retomada de transferência.
