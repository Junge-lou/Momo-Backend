<div align="center">
    <img src="./doc/images/logo.svg" width="84" height="84" alt="Momo Backend">
    <h1>Momo Backend</h1>
    <p><strong>轻量，便捷，易部署的博客评论系统</strong></p>
    <p>
        <img src="https://img.shields.io/badge/Node->=22-green" alt="Node">
        <img src="https://img.shields.io/badge/Cloudflare-Worker-orange?logo=cloudflare" alt="Cloudflare Worker">
        <img src="https://img.shields.io/badge/Go-1.25-00ADD8?logo=go&logoColor=white" alt="Go">
    </p>
    <p>
        <img src="https://img.shields.io/badge/SQLite-3E8E41?logo=sqlite&logoColor=white" alt="SQLite">
        <img src="https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white" alt="TS">
        <img src="https://img.shields.io/badge/Hono-FF6B35?logo=hono&logoColor=white" alt="Hono">
        <img src="https://img.shields.io/badge/Koa-33333D?logo=koa&logoColor=white" alt="Koa">
        <img src="https://img.shields.io/badge/Svelte-FF3E00?logo=svelte&logoColor=white" alt="Svelte">
        <img src="https://img.shields.io/badge/Vue-3.5+-4FC08D?logo=vue.js&logoColor=white" alt="Vue">
    </p>
    <img src="./doc/images/index.jpg" width="100%" alt="Demo">
</div>

<!-- ![License](https://img.shields.io/badge/license-MIT-blue) -->



## 快速开始

Momo Backend 包含前端和后端两个模块，需要分别进行部署。

### 前端部署

前端即为评论页面，一般集成在博客、论坛等位置，用于提交并展示评论。该组件 Svelte 进行开发。

前端可以通过 CDN 引入，也可以自行修改编译成js文件，集成到自己的项目中。具体的部署方式可以参考[frontend](./frontend/README.md)。

如果需要自己设计前端样式，或集成到已有的评论组件中，可以参考 [API 文档](./doc/api.md)自行开发。

### 后端部署

后端用于提供评论存储和评论管理服务，包括后端 API 应用和后端管理页面。

#### API 应用

API 应用维护了一个 SQLite 数据库，并对外提供 API 接口，目前提供了三种部署方式：

* 基于 Node.js 开发环境，需要服务器本地部署
* 基于 Go 开发的二进制文件，需要服务器本地部署
* 基于 Cloudflare Worker，无需服务器部署

具体部署方式请访问对应的文档获取具体的部署信息：[Node.js 版本](./nodejs/README.md)，[Go 版本](./go/README.md)，[Cloudflare Worker 版本](./worker/README.md)。

后续会提供Vercel版本；如果需要提供其他平台的部署方式，欢迎提交邮件或者 issue 。

#### 后端管理面板

提供一个可视化面板对评论数据进行管理，使用 Vue 开发。Release 中默认已集成编译好的静态文件，放在 `./public` 文件夹中，无需再次编译。

源码位于 `./dashboard` 目录下，可以自行修改页面，并重新编译。

## 版本更新

本项目仍处于维护状态，不定期进行更新。如果想要体验到最新功能，请参考[更新文档](./doc/update.md)进行更新。
## 其他

* [API 文档](./doc/api.md)
* [数据库表结构](./doc/data_table.md)
* [Momo 静态博客](https://github.com/Motues/Momo)

## TODO

- [ ] 支持其他评论系统的数据迁移
- [ ] 提供 Docker 一键部署
- [ ] 完善文档
- [ ] 优化页面


> 欢迎对本仓库提出建议，进行优化
> Made with ❤️ by [Motues](https://wwww.motues.top)
