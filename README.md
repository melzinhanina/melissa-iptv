# Melissa IPTV

Servidor Node.js leve para servir vídeos do Google Fotos a players IPTV.

## Como funciona

A origem do Google Fotos entrega o arquivo completo com HTTP 200 e ignora o cabeçalho Range. Por isso, o servidor faz o seguinte:

1. Busca a URL original do vídeo no primeiro acesso.
2. Segue o redirecionamento do Google Fotos.
3. Baixa o arquivo completo para um cache temporário em disco.
4. Responde ao player com HTTP 200 ou HTTP 206 e os intervalos solicitados.
5. Mantém somente o último vídeo no cache temporário para limitar o uso de disco.

**Importante:** isso não é Range verdadeiro na origem. O primeiro acesso precisa terminar o download inteiro antes de começar a reprodução e o seek. O cache fica no armazenamento temporário do serviço e pode ser perdido quando a instância reiniciar.

## Requisitos

- Node.js 20 ou superior
- Nenhuma dependência npm externa

## Preparar o catálogo

Crie um arquivo local chamado `videos.json` usando a saída do extrator. Ele não é versionado pelo Git porque contém URLs diretas e potencialmente privadas do Google Fotos.

Formato esperado:

```json
[
  {
    "id": "ID_DO_VIDEO",
    "title": "Vídeo 1",
    "url": "https://lh3.googleusercontent.com/...",
    "poster": "https://lh3.googleusercontent.com/...",
    "width": 720,
    "height": 900
  }
]
```

O servidor valida que as URLs de origem usem HTTPS e o host `lh3.googleusercontent.com`.

## Executar

```bash
npm start
```

Rotas:

- `GET /health` - estado do servidor
- `GET /api/videos` - catálogo sem expor as URLs de origem
- `GET /stream/ID_DO_VIDEO` - vídeo com suporte a Range no lado do player

## Hostless

Configure o comando de inicialização como `npm start`. O serviço deve fornecer a variável `PORT`.

Variáveis opcionais:

| Variável | Padrão | Descrição |
|---|---:|---|
| `PORT` | `8080` | Porta HTTP |
| `VIDEOS_JSON` | `./videos.json` | Caminho do catálogo |
| `MAX_VIDEO_BYTES` | `209715200` | Limite por vídeo (200 MiB) |
| `IPTV_TOKEN` | vazio | Token opcional para proteger API e streams |

Se configurar `IPTV_TOKEN`, envie `Authorization: Bearer SEU_TOKEN` nas requisições. Também é aceito `?token=SEU_TOKEN` para players que não permitem cabeçalhos personalizados.

Não coloque o arquivo `videos.json`, tokens ou URLs privadas em um repositório público. Adicione o catálogo diretamente ao ambiente de deploy por um método privado.

## Limitações

- Um vídeo inteiro é baixado antes de ser servido. Isso aumenta a latência inicial e consome tráfego e armazenamento temporário.
- Apenas um vídeo fica no cache temporário por vez.
- O limite padrão é 200 MiB por vídeo.
- O servidor não converte codecs nem altera a qualidade do vídeo.
