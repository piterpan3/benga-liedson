# BENGA ENVIOS — Vercel (versão limpa)

Esta versão foi reorganizada para o fluxo normal da Vercel:
- `index.html` e assets ficam na raiz para serem servidos como site estático;
- a API fica exclusivamente em `/api/[...route].mjs`;
- o backend é executado como Vercel Function;
- Node.js 24.x;
- não há `build` command nem `outputDirectory` a configurar;
- base inicial limpa (0 clientes, 0 encomendas, 0 avaliações);
- sem servidor `listen()` no deployment da Vercel.

## Deploy
1. Importe a pasta raiz deste projeto para a Vercel.
2. Framework Preset: Other/None.
3. Root Directory: raiz do projeto.
4. Build Command: deixe vazio.
5. Output Directory: deixe vazio.
6. Instale as dependências automaticamente.
7. Configure as variáveis de ambiente.
8. Para persistência, ligue um Vercel Blob Store privado e defina `BENGA_USE_BLOB=1`.
9. Para verificação real de e-mail, configure Resend.
10. Teste `/api/health` antes de aceitar clientes.

## Administrador
E-mail: `liedsonjunior001@gmail.com`
Senha: `Casagrande1@`

O e-mail do administrador é reservado e não pode criar uma conta de cliente.

## Pré-visualizações
As Preview Deployments automáticas da Vercel aparecem quando o projeto está ligado a Git e há push/PR numa branch de preview. Um upload de ZIP pode criar um deployment sem apresentar esse fluxo de Preview no painel; isso não é, por si só, um erro.
