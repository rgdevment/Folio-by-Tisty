# Folio by Tisty

[English](README.md)

Folio by Tisty convierte un documento de Tisty en un link que cualquiera puede
leer: anónimo, cifrado de punta a punta, y que se va solo después de un tiempo.
Es un **servicio**, aparte de la app Tisty, con su propio servidor, sus reglas y
sus promesas. Sus links viven en tisty.cl, y su sitio es
[www.tisty.app](https://www.tisty.app).

> **No promete lo que promete la app.** La app Tisty no tiene servidor y no
> recolecta nada. Folio sí tiene un servidor: guarda copias cifradas
> hasta que caducan, cuenta lecturas y lleva algunos registros anónimos. Qué
> guarda, para qué y por cuánto tiempo está en su
> [política de privacidad](docs/PRIVACIDAD.md).

## Cómo funciona

- **Se comparte desde Tisty,** con la fila *Compartido* del panel de un
  documento, desde la versión 1.42.0. No hay otra forma de compartir, y no hay
  cuentas: el link es el permiso.
- **Cada documento tiene tres links:** uno para leer, uno para editar y uno
  para administrar.
- **Lo que compartes se cifra en tu Tisty antes de salir.** La llave viaja en
  el link, después del `#`, que los navegadores nunca envían. El servidor
  guarda bytes que no puede leer.
- **Cada versión va firmada** con la llave de tu equipo, así quien lee sabe que
  viene de ti.
- **Caduca sola** después del tiempo sin actividad que elijas, de un día a 15
  como mucho. Tu documento se queda en tu Tisty.
- **Un link perdido no se puede recuperar,** porque el servidor nunca tuvo su
  llave. Mientras el documento está compartido, Tisty guarda sus links: vuelve a
  copiarlos desde su fila *Compartido*. Si ya caducó o lo dejaste de compartir,
  compártelo otra vez para tener links nuevos.
- **Un link se abre en cualquier navegador,** en tisty.cl, y se edita en otro
  Tisty con *Editar en Tisty*.

Cómo funcionan el cifrado y las firmas, y qué no protegen, está en la
[política de seguridad](docs/SEGURIDAD.md).

## Sus documentos

| | |
|---|---|
| [Términos de uso](docs/TERMINOS.md) | Qué se permite, denuncias y retiro, garantías y responsabilidad |
| [Política de privacidad](docs/PRIVACIDAD.md) | Qué guarda el servicio, para qué, por cuánto tiempo, y tus derechos |
| [Política de seguridad](docs/SEGURIDAD.md) | Cómo reportar una vulnerabilidad, y qué protege el diseño y qué no |

## Quién lo opera

Mario, persona natural en Chile, como proyecto sin fines de lucro y de código
público. No hay una empresa detrás y nadie gana dinero con él. Contacto:
<rgdevment@tisty.app>.

## Su código

Se está escribiendo de nuevo desde cero en TypeScript, sobre Cloudflare Workers,
D1 y R2, y el servicio está abierto, en beta: [tisty.cl](https://tisty.cl/es/)
dice qué es. Se entiende con la
[app Tisty](https://github.com/rgdevment/Tisty) por un contrato que guarda el
repositorio de la app: los formatos de lo que viaja y las reglas de estilo de la
hoja. El código anterior, en Rust, queda en la rama
`chore/rust-service-backup` del [repositorio archivado](https://github.com/rgdevment/Folio-by-Tisty-aglp).

## Licencia

Folio está bajo la [Functional Source License 1.1, Apache 2.0 Future
License](LICENSE) (FSL-1.1-ALv2).

- **Gratis para cualquiera:** leerlo, auditarlo, usarlo, cambiarlo y compartirlo,
  en tu casa o en tu trabajo.
- **No permitido:** ofrecerlo a otros en un producto o servicio comercial que
  compita con Folio.
- **Cuándo se abre una versión:** dos años después de publicarse, esa versión
  también se puede usar bajo la Apache License 2.0, sin límite para competir.

El contrato con Tisty va incluido con
[un permiso adicional](https://github.com/rgdevment/Tisty/blob/main/contracts/ADDITIONAL-PERMISSION.md),
tal como se publica y sin cambios. En cualquier otro lugar, o si se cambia, sigue
bajo la AGPL-3.0.

Esta licencia no da ningún derecho sobre los nombres ni las marcas de Folio y
Tisty. Los dibujos de la marca y la mascota, `src/page/public/icon.svg` y
`src/page/public/tisto.svg`, no forman parte de ella.

Lo anterior a este repositorio, hasta el commit `dad2c24`, sigue bajo la
AGPL-3.0 en [su archivo](https://github.com/rgdevment/Folio-by-Tisty-aglp).
