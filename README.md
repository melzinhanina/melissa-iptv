# Melissa IPTV Tunnel

Túnel reverso simples em Node.js para permitir que um serviço HTTP local no Termux seja acessado através de um servidor público.

## Arquitetura

```
Aplicativo IPTV
      │
      ▼
Servidor público
melissa-iptv
      │
      │ WebSocket persistente
      ▼
Termux
      │
      ▼
127.0.0.1:8000
serviço IPTV local
```

O Termux inicia a conexão de saída com o servidor público. Isso evita depender de uma conexão de entrada direta no celular.

## Servidor público

```bash
npm install
TUNNEL_TOKEN="um-token-grande" npm start
```

O servidor ficará aguardando na porta definida por `PORT`.

## Cliente no Termux

```bash
npm install
TUNNEL_URL="wss://SEU_HOST/tunnel" \
TUNNEL_TOKEN="o-mesmo-token" \
LOCAL_ORIGIN="http://127.0.0.1:8000" \
npm run client
```

O cliente mantém a conexão WebSocket e reconecta automaticamente se ela cair.

## Segurança

O endpoint do tunnel exige `TUNNEL_TOKEN`. Não coloque o token no Git.

O servidor público apenas repassa as requisições HTTP recebidas para o serviço local indicado pelo cliente.

## Próxima etapa

Depois de validar o tunnel básico, podemos adicionar:
- health check;
- heartbeat;
- múltiplos clientes/tunnels;
- controle de conexões;
- streaming mais eficiente;
- suporte explícito a Range/206;
- métricas;
- limites de tamanho;
- autenticação separada do endpoint público.
