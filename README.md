# Melissa IPTV

Servidor IPTV em Node.js que atualiza automaticamente o catálogo a partir de um álbum compartilhado do Google Fotos e serve os vídeos com suporte a Range no lado do player.

## Inicialização automática

O comando de inicialização é:

```bash
npm start
```

A sequência de inicialização é automática:

1. `start.js` chama `extractor.js`.
2. O extrator consulta o álbum configurado em `PHOTOS_ALBUM_URL`. Se a variável não existir, usa o álbum padrão definido em `start.js`.
3. Filtra somente vídeos e grava/atualiza `videos.json`.
4. Somente depois da extração bem-sucedida, `start.js` importa e inicia `server.js`.

Se o álbum não puder ser consultado ou nenhum vídeo for encontrado, o processo encerra com erro em vez de iniciar com um catálogo vazio/desatualizado.

## Configuração no Hostless

Configure estas variáveis no painel do serviço:

| Variável | Obrigatória | Descrição |
|---|---|---|
| `PHOTOS_ALBUM_URL` | Não | URL alternativa do álbum. Se omitida, usa a URL padrão de `start.js` |
| `PORT` | Fornecida pelo Hostless | Porta HTTP do serviço |
| `IPTV_TOKEN` | Não | Token opcional para proteger API e streams |
| `MAX_VIDEO_BYTES` | Não | Limite por vídeo em bytes, padrão 200 MiB |

Comando de inicialização: `npm start`.

**Privacidade:** o repositório é público e a URL padrão do álbum está escrita em `start.js`. Qualquer pessoa que veja o código também poderá obter essa URL. Para trocar o álbum sem alterar o código, defina `PHOTOS_ALBUM_URL` no painel.

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

No Termux, instale a versão LTS e as dependências do projeto:

```bash
pkg update
pkg install nodejs-lts
npm install
npm start
```

Para executar somente o extrator:

```bash
npm run extract
```

A variável `PHOTOS_ALBUM_URL` pode ser definida para substituir o álbum padrão.

O arquivo `videos.json` é gerado automaticamente e está no `.gitignore`, pois contém URLs diretas das mídias.

## Arquivos

- `start.js`: orquestra extração e inicialização do servidor.
- `extractor.js`: consulta o álbum e gera o catálogo.
- `server.js`: API e streaming pseudo-206.
- `videos.example.json`: exemplo de catálogo vazio.
