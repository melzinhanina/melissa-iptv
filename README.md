# Melissa IPTV

Servidor IPTV em Node.js que atualiza automaticamente o catálogo a partir de um álbum compartilhado do Google Fotos e serve os vídeos com suporte a Range no lado do player.

## Inicialização automática

O comando de inicialização é:

```bash
npm start
```

A sequência de inicialização é automática:

1. `start.js` chama `extractor.js`.
2. O extrator consulta o álbum definido em `PHOTOS_ALBUM_URL`.
3. Filtra somente vídeos e grava/atualiza `videos.json`.
4. Somente depois da extração bem-sucedida, `start.js` importa e inicia `server.js`.

Se a URL não estiver configurada, o álbum não puder ser consultado ou nenhum vídeo for encontrado, o processo encerra com erro em vez de iniciar com um catálogo vazio/desatualizado.

## Configuração no Hostless

Configure estas variáveis no painel do serviço:

| Variável | Obrigatória | Descrição |
|---|---|---|
| `PHOTOS_ALBUM_URL` | Sim | URL compartilhada do álbum do Google Fotos |
| `PORT` | Fornecida pelo Hostless | Porta HTTP do serviço |
| `IPTV_TOKEN` | Não | Token opcional para proteger API e streams |
| `MAX_VIDEO_BYTES` | Não | Limite por vídeo em bytes, padrão 200 MiB |

Comando de inicialização: `npm start`.

O álbum usado pelo extrator deve estar compartilhado de forma que o serviço consiga acessá-lo. Não coloque a URL do álbum no código nem em commits públicos: configure-a como variável de ambiente no Hostless.

## Rotas

- `GET /health` - estado do servidor e quantidade de vídeos carregados.
- `GET /api/videos` - catálogo com título, poster, dimensões e URL interna de streaming.
- `GET /stream/ID_DO_VIDEO` - vídeo.

Se `IPTV_TOKEN` estiver definido, envie `Authorization: Bearer SEU_TOKEN`. Também é aceito `?token=SEU_TOKEN` para players sem cabeçalhos personalizados.

## Pseudo-206 e cache

O Google Fotos entrega o vídeo com HTTP 200 e não respeita Range. Para emular o comportamento esperado pelo player, o servidor:

1. Baixa o vídeo inteiro no primeiro acesso para cache temporário em disco.
2. Responde com HTTP 200 para requisições sem Range.
3. Responde com HTTP 206 e `Content-Range` para requisições com Range.
4. Mantém apenas o último vídeo em cache para limitar o uso de disco.

Portanto, o primeiro acesso a cada vídeo aguarda o download completo antes de começar a reprodução. O cache usa a pasta temporária do sistema e pode desaparecer quando o Hostless reiniciar ou recriar a instância.

## Desenvolvimento local

Requer Node.js `^22.18.0 || >=24.11.0`.

```bash
npm install
PHOTOS_ALBUM_URL="LINK_COMPARTILHADO_DO_ALBUM" npm start
```

Para executar somente o extrator:

```bash
PHOTOS_ALBUM_URL="LINK_COMPARTILHADO_DO_ALBUM" npm run extract
```

O arquivo `videos.json` é gerado automaticamente e está no `.gitignore`, pois contém URLs diretas das mídias.

## Arquivos

- `start.js`: orquestra extração e inicialização do servidor.
- `extractor.js`: consulta o álbum e gera o catálogo.
- `server.js`: API e streaming pseudo-206.
- `videos.example.json`: exemplo de catálogo vazio.
