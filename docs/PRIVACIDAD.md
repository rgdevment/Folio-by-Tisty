# Privacidad de Folio by Tisty

**Vigente desde el 6 de noviembre de 2026.**

## En corto

Folio guarda lo mínimo para funcionar, y casi todo va cifrado con una
llave que nunca recibe. No hay cuentas, ni cookies, ni analítica, ni anuncios,
ni nada de terceros en la página. Lo que guarda caduca solo, salvo la parte
pública de tu llave y las llaves que retiraste; el operador borra sus correos a
mano. Esta política cuenta exactamente qué guarda, por qué y por cuánto tiempo.

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
| El documento cifrado y sus adjuntos, con sus 3 últimas versiones y las reemplazadas en los últimos 7 días | Servirlo a quien tiene el link, y que una denuncia alcance lo que alguien reemplazó | Hasta el plazo sin actividad que elijas, de 15 días como mucho, o hasta que dejes de compartirlo. Con una denuncia seria o una orden, deja de servirse y queda hasta 180 días, o lo que pida una orden o una autoridad |
| El manifiesto en claro: cuántas partes tiene, cuánto pesa cada una, de qué tipo son y su versión | Aplicar los topes sin leer el contenido | Lo mismo que el documento |
| El link de administrar, guardado como resumen (hash), y la llave pública del token del link de editar, que nunca llega al servidor | Comprobar quién puede cambiar o borrar | Lo mismo que el documento |
| Tu llave pública y su certificado, en lo que compartes | Que quien lee sepa que es tuyo | Lo mismo que el documento |
| Tu llave pública sola, el día en que Folio la vio por primera vez, y qué versión de los términos aceptó y en qué hora lo supo el servidor, sin relación con ninguna red ni documento | Que los topes y la reputación sigan con ella, y que una llave nueva parta con los más bajos | Para siempre, aunque tus documentos ya no estén |
| Cuántas veces se leyó, contando una vez por día y por visitante | Mostrarte las lecturas en Tisty | Lo mismo que el documento |
| Una línea por cada lectura servida: el id del link (sin su llave, así que no abre nada), el país y el centro de datos de Cloudflare, nunca tu IP | Saber cuánto se lee cada documento y desde dónde, y dimensionar el servicio | Hasta 7 días, en los registros de Workers de Cloudflare |
| Un resumen de tu IP (un HMAC con una llave que cambia) | Topes por IP y bloqueos ante abuso | Lo que dura la cuota o el bloqueo, y hasta un día más |
| Una copia diaria de la base de datos, cifrada con una llave guardada fuera de línea, sin los resúmenes de lectura del día ni los cupos, y sin los documentos | Recuperarse de una falla | 30 días, en GitHub |
| Lo que el operador hizo con un documento y por qué, también abrirlo: su id, la acción y el motivo | Poder responder por ello después | 180 días, o mientras el documento esté retenido |
| Un link de caso, para verificar una denuncia o entregarlo a una autoridad: un resumen de su token, el documento y la versión que abre, cada apertura y, si es para una autoridad, los registros del documento, cifrados con una clave que Folio no guarda y sin la red ni el correo de quien denunció | Que quien verifica o investiga lea esa versión aunque el documento esté bloqueado | 30 días; las aperturas, como lo anterior |
| Un resumen por correo al operador, hasta dos veces al día: el id de los links denunciados, bloqueados o reclamados, la categoría y cuántas redes denunciaron, nunca una llave, una IP o el contenido | Avisarle qué revisar | Hasta 180 días, o más si una orden lo pide, en su buzón de Migadu |
| Lo que le escribes al operador por correo, con tu dirección | Responderte | Hasta 180 días desde el último mensaje, o más si una orden lo pide, en su buzón de Migadu |
| Las llaves que retiraste, hasta 64, como las firmó tu raíz: la parte pública de la llave y la de tu raíz | Para que quien lea sepa que una llave robada o retirada ya no habla por ti | Para siempre, porque quien lea siempre tiene que poder saberlo |
| Las denuncias: categoría, detalle y versión denunciada, en claro; si lo dejaron el link y un correo, sellados para que solo el operador los abra; y un resumen de la red de quien denuncia (un HMAC con una llave que cambia cada 180 días), para que cada red denuncie una sola vez | Moderar y enviarlas a quien corresponde | 180 días, o más si una orden o una autoridad lo pide. Si el operador comprueba que era falsa, el resumen de esa red queda 180 días desde entonces, para que deje de contar |

**Sobre la firma:** tu llave pública permite saber que dos documentos son de la
misma persona, aunque no quién eres.

**Sobre las lecturas:** se cuentan sin guardar quién leyó. Para no contar dos
veces a la misma persona el mismo día se usa un resumen temporal, que se
descarta al terminar el día. Su llave cambia cada día y no se guarda. La base de
datos conserva su propia copia hasta por 30 días, para recuperarse de una falla,
y el resumen sigue ahí hasta entonces; nunca entra en los respaldos.

## Cloudflare y otros proveedores

Folio corre en Cloudflare (Workers, D1 y R2). Cloudflare recibe tu IP y
las peticiones al conectarte, como cualquier servidor web, y las trata según su
propia [política de privacidad](https://www.cloudflare.com/privacypolicy/).
Nunca recibe la llave del `#`, así que tampoco puede leer lo que compartes.

La página de `folio.tisty.app` solo explica qué es Folio. Son archivos fijos: no
guarda nada de ti, ni en el servidor ni en tu navegador. Cloudflare también
recibe tu IP y tus peticiones al visitarla.

También participan otros tres, cada uno con su propia política:

- **[Migadu](https://www.migadu.com/privacy/)** lleva y guarda el correo del
  operador, con lo que dice la tabla de arriba.
- **[GitHub](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement)**
  guarda las copias de la base de datos, cifradas con una llave que no tiene.
  Tisty también le pide los límites y los términos antes de compartir, así que
  GitHub recibe la IP de quien va a compartir.
- **[Healthchecks.io](https://healthchecks.io/privacy/)** recibe una señal cuando
  termina cada tarea programada, para avisar si deja de llegar. No lleva datos
  de nadie.

Estos proveedores operan fuera de Chile, así que lo que reciben sale del país.

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
  compartirlo desde Tisty. Deja de servirse de inmediato y se borra del servidor
  en la siguiente limpieza, normalmente antes de una hora; durante un bloqueo por
  gasto o una falla puede tardar más. Una denuncia seria o una orden pueden
  obligar a conservarlo.
- **El correo que dejaste en una denuncia:** escribe a <abuso@tisty.app> con el
  id del documento y el operador lo borra. Sigue hasta 30 días en los respaldos
  cifrados.
- **Cualquier otra petición:** escribe a <rgdevment@tisty.app>. El resumen de
  tu IP no permite saber quién eres, así que en general no hay datos que
  puedan asociarse a ti.
- **Tu llave pública:** solo tú puedes demostrar que es tuya, así que firma la
  petición con ella. Sale de la lista de llaves y parte de nuevo como una
  nueva, sin su reputación y sin ninguna marca. Sigue mientras duren estos
  lugares: en los documentos que sigues compartiendo y las versiones que firmaste,
  en una llave que retiraste, en lo que guarda una denuncia hasta por 180 días y
  en los respaldos por 30 días.

## Menores de edad

Folio no está pensado para menores de 14 años.

## Cambios

Cada cambio a esta política queda en el repositorio público, con su fecha.

[English](PRIVACY.md)
