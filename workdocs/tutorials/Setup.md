### ***Initial Setup***

#### if you use github

create a new project using this one as a template.

clone it `git clone <project>` and navigate to the root folder `cd <project>`

#### If your project has private dependencies or publishes to private npm registries, create an `.npmrc` containing:

```text
@<scope1>:registry=https://<ADDRESS>.com/api/v4/packages/npm/
@<scope2>:registry=https://<ADDRESS>.<DOMAIN>.com/api/v4/packages/npm/
//<ADDRESS>.<DOMAIN>.com/:_authToken=${TOKEN}
//<ADDRESS>.<DOMAIN>.com/api/v4/groups/<GROUP_ID>/packages/npm/:_authToken=${TOKEN}
//<ADDRESS>.<DOMAIN>.com/api/v4/projects/<PROJECT_ID>/packages/npm/:_authToken=${TOKEN}
```

Changing:
 - <ADDRESS> to `gitlab` or `github` (or other);
 - <DOMAIN> to your domain if any (if you are using plain gitlab or github use empty and take care to remove the extra `.`);
 - <GROUP_ID> to your project's group id (if any). otherwise remove this line
 - <PROJECT_ID> to your project's id

and adding a `.token` file containing your access token to the private registries na repositories.

### Installation

Run `npm install` to install the dependencies. The workspace root's `postinstall` hook (`scripts/link-paperclip-sdk.mjs`) symlinks the Paperclip plugin SDK reference packages from the `paperclip/` submodule into `node_modules/@paperclipai/` (they cannot be installed from a registry — see the [Developer Guide](DeveloperGuide.md#building-and-testing)).

The extracted packages install the same way, each in its own directory: `common/`, `plugins/paperclip/`, and `plugins/pixel-agents/`.

> **Upgrading from the old combined root package?** The repo root is no longer a published npm package — it is a private workspace root, and the former single combined entry is removed and no longer shipped. Build/install the three workspace packages above instead; see the upgrade path in the [package README](../../README.md#upgrading-from-the-former-combined-package) and the deployment runbook in [`deploy/README.md`](../../deploy/README.md#upgrading-a-deployment-from-the-former-combined-package).