# Melissa IPTV 📺

Projeto pessoal para organizar vídeos próprios e reproduzi-los em uma interface web.

## Arquitetura planejada

- **Catálogo:** script Node.js para organizar os metadados dos vídeos.
- **Armazenamento:** Cloudflare R2 para os arquivos de vídeo.
- **Player:** site estático no Cloudflare Pages.
- **Playlist:** M3U gerada a partir do catálogo.

## Estado atual

Estrutura inicial do projeto. A integração com Google Fotos e R2 deve ser configurada com credenciais próprias, guardadas em variáveis de ambiente e nunca commitadas.

## Requisitos

- Node.js 20 ou superior para os scripts de catálogo.
- Uma conta Cloudflare com R2 e Pages, quando chegar à etapa de publicação.

## Segurança

Não coloque tokens, chaves, cookies, arquivos de sessão ou URLs privadas no GitHub. Use variáveis de ambiente e mantenha o arquivo `.env` fora do repositório.
