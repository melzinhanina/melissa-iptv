# Melissa IPTV / Mahoraga-IPTV

Este repositório atualmente contém duas partes:

- **Melissa API**: API Node.js existente para streaming de mídia resolvida pelo endpoint público TikWM.
- **Mahoraga-IPTV (protótipo)**: módulo JavaScript que busca HTML e extrai texto útil para análise posterior por IA.

## Requisitos

- Node.js 22.19 ou superior
- npm

## Instalação

```sh
npm install
```

## API existente

O comando padrão continua sendo:

```sh
npm start
```

A API usa a variável `PORT` quando hospedada e mantém as rotas já implementadas em `server.js`.

## Testar o extrator Mahoraga

```sh
npm run mahoraga -- https://example.com/
```

O extrator retorna JSON com URL, título, descrição, subtítulos e texto principal. Ele remove alguns elementos normalmente dispensáveis e limita o HTML recebido a 2 MB e o texto extraído a 15 mil caracteres.

## Limitações e segurança

- O protótipo usa `fetch` nativo do Node.js e Cheerio; não executa JavaScript da página.
- Sites que montam conteúdo dinamicamente podem retornar pouco texto.
- A filtragem de elementos é heurística e pode remover conteúdo relevante ou deixar anúncios passar.
- Antes de aceitar URLs de usuários publicamente, é necessário reforçar a proteção contra SSRF, incluindo resolução DNS/IP e validação de todos os destinos de rede.
- Adicione autenticação e limites de requisições antes de expor a API publicamente.
- Não coloque chaves de API nem segredos no código ou no GitHub.

## Próximas etapas

1. Testes automatizados do extrator.
2. Proteção de URLs e tratamento de codificações.
3. Integração opcional com Tavily ou outro mecanismo de pesquisa.
4. Integração com IA somente depois de validar e normalizar o conteúdo extraído.
