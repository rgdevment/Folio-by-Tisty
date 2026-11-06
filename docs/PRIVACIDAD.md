# Privacidad de Folio by Tisty

**Borrador del 5 de noviembre de 2026.** Folio todavía no está abierto.

## En corto

Folio guarda lo mínimo para funcionar, y casi todo va cifrado con una
llave que nunca recibe. No hay cuentas, ni cookies, ni analítica, ni anuncios,
ni nada de terceros en la página. Lo que guarda caduca solo. Esta política
cuenta exactamente qué guarda, por qué y por cuánto tiempo.

Quién responde por estos datos: Mario, persona natural en Chile, que opera
Folio sin fines de lucro. Contacto: <rgdevment@tisty.app>.

## Lo que no puede ver

- **El contenido de lo que compartes.** El texto, las imágenes, los adjuntos y la
  firma interna van cifrados en tu Tisty antes de salir. La llave va en el link,
  después del `#`, y los navegadores no la envían al servidor.
- **Quién eres.** No hay cuentas, ni correos, ni nombres.

## Lo que sí guarda, y por cuánto tiempo

| Qué | Para qué | Por cuánto tiempo |
|---|---|---|
| El documento cifrado y sus adjuntos, con sus 3 últimas versiones y las reemplazadas en los últimos 7 días | Servirlo a quien tiene el link, y que una denuncia alcance lo que alguien reemplazó | Hasta el plazo sin actividad que elijas, de 15 días como mucho, o hasta que dejes de compartirlo. Con una denuncia seria o una orden, deja de servirse y queda hasta 180 días, o lo que la orden pida |
| El manifiesto en claro: cuántas partes tiene, cuánto pesa cada una, de qué tipo son y su versión | Aplicar los topes sin leer el contenido | Lo mismo que el documento |
| El link de administrar, guardado como resumen (hash), y la llave pública del token del link de editar, que nunca llega al servidor | Comprobar quién puede cambiar o borrar | Lo mismo que el documento |
| Si firmas, tu llave pública y su certificado | Que quien lee sepa que es tuyo | Lo mismo que el documento |
| Cuántas veces se leyó, contando una vez por día y por visitante | Mostrarte las lecturas en Tisty | Lo mismo que el documento |
| Una línea por cada lectura servida: el id del link (sin su llave, así que no abre nada), el país y el centro de datos de Cloudflare, nunca tu IP | Saber cuánto se lee cada documento y desde dónde, y dimensionar el servicio | 3 días, en los registros de Workers de Cloudflare |
| Un resumen de tu IP (un HMAC con una llave que cambia) | Topes por IP y bloqueos ante abuso | Lo que dura la cuota o el bloqueo |
| Una copia diaria de la base de datos, cifrada con una llave guardada fuera de línea, sin los resúmenes de lectura del día ni los cupos, y sin los documentos | Recuperarse de una falla | 30 días, en GitHub |
| Las llaves que retiraste, como las firmó tu raíz: la parte pública de la llave y la de tu raíz | Para que quien lea sepa que una llave robada o retirada ya no habla por ti | Para siempre, porque quien lea siempre tiene que poder saberlo |
| Las denuncias: categoría, detalle, la versión denunciada, si lo dejaron el link, sellado para que solo el operador lo abra, y un resumen de la red de quien denuncia (un HMAC con una llave que cambia cada 180 días), para que cada red denuncie una sola vez | Moderar y enviarlas a quien corresponde | 180 días, o más si una orden lo pide. Si se acepta un reclamo contra la denuncia, el resumen de esa red queda 180 días desde entonces, para que deje de contar |

**Sobre la firma:** si firmas lo que compartes, tu llave pública permite saber
que dos documentos firmados son de la misma persona, aunque no quién eres. En lo
no listado firmar es opcional por eso.

**Sobre las lecturas:** se cuentan sin guardar quién leyó. Para no contar dos
veces a la misma persona el mismo día se usa un resumen temporal, que se
descarta al terminar el día. Su llave cambia cada día y no se guarda. La base de
datos conserva su propia copia hasta por 30 días, para recuperarse de una falla,
y el resumen sigue ahí hasta entonces; nunca entra en los respaldos.

## Cloudflare

Folio corre en Cloudflare (Workers, D1 y R2). Cloudflare recibe tu IP y
las peticiones al conectarte, como cualquier servidor web, y las trata según su
propia [política de privacidad](https://www.cloudflare.com/privacypolicy/).
Nunca recibe la llave del `#`, así que tampoco puede leer lo que compartes.

## La promesa del cifrado, dicha con honestidad

- **Entre dos Tisty**, nadie más puede leer lo compartido: ni el operador, ni
  Cloudflare, ni quien robe la base de datos.
- **En el navegador**, el código que descifra lo entrega el mismo servidor. Eso
  protege contra una filtración o una orden sobre lo guardado, pero no contra un
  operador que decidiera cambiar ese código para robar llaves. El código es
  público para que cualquiera pueda revisarlo.
- **Una denuncia con el link para leerlo** permite abrir ese documento. Solo se
  hace en los casos que dicen los [términos](TERMINOS.md), y cada apertura
  queda registrada.

## Tus derechos

Bajo la Ley 21.719 puedes pedir saber qué datos tuyos hay, corregirlos,
borrarlos u oponerte a su uso. Como no hay cuentas, lo más directo es:

- **Borrar lo que compartiste:** con tu link de administración, o dejando de
  compartirlo desde Tisty. Se borra del servidor de inmediato.
- **Cualquier otra petición:** escribe a <rgdevment@tisty.app>. El resumen de
  tu IP no permite saber quién eres, así que en general no hay datos que
  puedan asociarse a ti.

## Menores de edad

Folio no está pensado para menores de 14 años.

## Cambios

Cada cambio a esta política queda en el repositorio público, con su fecha.

[English](PRIVACY.md)
