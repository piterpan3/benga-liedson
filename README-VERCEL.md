# BENGA ENVIOS — Vercel (corrigido)

## Importante
Este projeto está preparado para a Vercel com `index.html` na raiz e `api/[...route].mjs` para a API.
Não é preciso Node/Express como processo de arranque nem `npm start` na Vercel.

## Variáveis
Obrigatórias para o administrador:
- `ADMIN_EMAIL=liedsonjunior001@gmail.com`
- `ADMIN_PASSWORD=Casagrande1@`

Para dados persistentes em produção, ligue um **Vercel Blob Store privado** ao projeto. O código tenta usar o Blob automaticamente na Vercel e, se o Blob ainda não estiver ligado, não deixa o site cair em 500: fica temporariamente em armazenamento de instância até o Blob ser ligado.

Para verificação real de e-mail, configure:
- `RESEND_API_KEY`
- `EMAIL_FROM`

Google/Facebook só ficam ativos quando as respetivas credenciais OAuth forem configuradas.

## Vercel Import
- Root Directory: raiz deste projeto
- Framework Preset: Other
- Build Command: vazio
- Output Directory: vazio
- Install Command: `npm install`

O `index.html` é um ficheiro estático na raiz e a função está em `/api`.

## Preview Deployments
A mensagem **"Sem implantações de pré-visualização"** está relacionada com o Git/Preview do projeto. Para previews automáticos por commit, ligue o projeto a GitHub/GitLab/Bitbucket. O site pode estar publicado em produção sem haver previews automáticos.

## Verificação rápida
- `/api/health` deve devolver `{"ok":1}`.
- `liedsonjunior001@gmail.com` com `Casagrande1@` entra como administrador.
- O e-mail do administrador não pode ser registado como cliente.
- A base inicial é limpa: 0 clientes, 0 encomendas, 0 avaliações.
