# Privacidad de Folio by Tisty

**Versión 8, vigente desde el 11 de noviembre de 2026.**

## En corto

Folio guarda lo mínimo para funcionar, y casi todo va cifrado con una
llave que nunca recibe. No hay cuentas, ni cookies, ni analítica, ni anuncios,
ni nada de terceros en la página. Lo que guarda caduca solo, salvo la parte
pública de tu llave y las llaves que retiraste; el operador borra sus correos a
mano. Esta política cuenta exactamente qué guarda, por qué y por cuánto tiempo.

Quién responde por estos datos: Mario Hidalgo G., persona natural en Chile, que
opera Folio sin fines de lucro. Contacto: <rgdevment@tisty.app>.

## Lo que no puede ver

- **El contenido de lo que compartes.** El texto, las imágenes, los adjuntos y la
  firma interna van cifrados en tu Tisty antes de salir. La llave va en el link,
  después del `#`, y los navegadores no la envían al servidor.
- **Quién eres.** No hay cuentas, ni correos, ni nombres.

## Lo que sí guarda, y por cuánto tiempo

| Qué | Para qué | Por cuánto tiempo |
|---|---|---|
| El documento cifrado y sus adjuntos, con su última versión y las reemplazadas en los últimos 3 días | Servirlo a quien tiene el link, y que una denuncia alcance lo que alguien reemplazó | Hasta el plazo sin actividad que elijas, de 15 días como mucho, o hasta que dejes de compartirlo. Si lo pausas, no se sirve y queda hasta 30 días, salvo que lo reanudes. Si una denuncia de engaño o grave lo retiene, el operador lo bloquea o una orden lo retiene, no se sirve una vez que caduca, dejas de compartirlo o se bloquea, y queda junto con sus otros idiomas hasta 180 días desde la última denuncia o el bloqueo, o lo que pida una orden o una autoridad. Durante un corte por gasto o una falla, lo reemplazado puede tardar más en borrarse |
| El manifiesto en claro: cuántas partes tiene, cuánto pesa cada una, de qué tipo son y su versión | Aplicar los topes sin leer el contenido | Lo mismo que el documento |
| El link de administrar, guardado como resumen (hash), y la llave pública del token del link de editar, que nunca llega al servidor | Comprobar quién puede cambiar o borrar | Lo mismo que el documento |
| Tu llave pública y su certificado, en lo que compartes, con la hora exacta en que llegó cada versión | Que quien lee sepa que es tuyo y desde cuándo | Lo mismo que el documento |
| Si editas lo que otra persona comparte: tu llave pública, la de la máquina desde la que mandaste tu última versión y la primera versión que firmaste | Que quien lee sepa quién lo editó y reciba las llaves que retiraste, para que ya no hablen por ti | Lo mismo que el documento |
| Si revisas los idiomas que otra persona sumó a lo tuyo, tu palabra sobre ellos, firmada con tu llave: solo cuántas veces revisaste y un resumen (hash) de las revisiones, nunca qué idiomas, con la hora exacta en que llegó | Que quien lee muestre solo los idiomas que mantuviste | Lo mismo que el documento |
| Tu llave pública sola, el día en que Folio la vio por primera vez, qué versión de los términos aceptó y en qué hora lo supo el servidor, y si el operador la bloqueó, sin relación con ninguna red ni documento | Que los topes y la reputación sigan con ella, y que una llave nueva parta con los más bajos | Para siempre, aunque tus documentos ya no estén |
| Cuántas veces se leyó, contando una vez por día y por visitante, y en qué horas en un día con 5 o más | Mostrarte las lecturas en Tisty | Lo mismo que el documento |
| Una línea por cada lectura servida: el id del link (sin su llave, así que no abre nada), el país y el centro de datos de Cloudflare, nunca tu IP | Saber cuánto se lee cada documento y desde dónde, y dimensionar el servicio | Hasta 7 días, en los registros de Workers de Cloudflare |
| Un resumen de tu IP (un HMAC con una llave que cambia), también junto al documento que subiste ese día | Topes por IP y bloqueos ante abuso, y que el operador vea cuándo una misma red crea muchas llaves o documentos | Lo que dura la cuota o el bloqueo, y hasta un día más |
| Por cada documento y día: cuántas redes lo leyeron, cuántas con prueba de trabajo, en cuántas horas y cuántas en la hora de más lecturas, y si la única fue la que lo subió, nunca cuáles | Que el operador distinga un grupo de lectores de una granja de bots, o un documento que solo su dueño mantiene vivo | 31 días, o menos si el documento se va antes |
| Una copia diaria de la base de datos, cifrada con una llave guardada fuera de línea, sin los resúmenes de lectura del día, los cupos ni la red que subió cada documento, y sin los documentos | Recuperarse de una falla | 30 días, en GitHub. Mientras está ahí cualquiera con una cuenta de GitHub puede descargarla, siempre cifrada con una llave poscuántica guardada fuera de línea |
| Lo que el operador hizo con un documento o una llave y por qué, también abrirlo: su id, la acción y el motivo | Poder responder por ello después | 180 días, o mientras una orden retenga el documento |
| Un link de caso, para verificar una denuncia o entregarlo a una autoridad: un resumen de su token, el documento y la versión que abre, cada apertura y, si es para una autoridad, los registros del documento, cifrados con una clave que Folio no guarda y sin la red ni el correo de quien denunció | Que quien verifica o investiga lea esa versión aunque el documento esté bloqueado | 30 días; las aperturas, como lo anterior |
| Un resumen por correo al operador, hasta cuatro veces al día: el id de los links denunciados, bloqueados o reclamados, la categoría y cuántas redes denunciaron, nunca una llave, una IP o el contenido | Avisarle qué revisar | Hasta 180 días, o más si una orden lo pide, en su buzón de Migadu |
| Lo que le escribes al operador por correo, con tu dirección | Responderte | Hasta 180 días desde el último mensaje, o más si una orden lo pide, en su buzón de Migadu |
| Las llaves que retiraste, hasta 64, como las firmó tu raíz: la parte pública de la llave y la de tu raíz | Para que quien lea sepa que una llave robada o retirada ya no habla por ti | Para siempre, porque quien lea siempre tiene que poder saberlo |
| Las denuncias: categoría, detalle y versión denunciada, en claro; si lo dejaron el link y un correo, sellados para que solo el operador los abra; y un resumen de la red de quien denuncia (un HMAC con una llave que cambia cada 180 días), para que cada red denuncie una sola vez, junto al número de su proveedor (ASN), para que un bloqueo necesite denuncias de proveedores distintos | Moderar y enviarlas a quien corresponde | 180 días, o más si una orden o una autoridad lo pide. Si el operador comprueba que era falsa, el resumen de esa red queda, con el día y la hora en que se marcó falsa por primera vez, hasta 180 días desde la última vez que se marcó, para que deje de contar |

**Sobre la firma:** tu llave pública permite saber que dos documentos son de la
misma persona, aunque no quién eres. La excepción es la llave del operador, que
firma como rgdevment: su parte pública y ese nombre están publicados en los
límites de Folio, y lo que firma puede mostrarse como «verificado».

**Sobre las lecturas:** se cuentan sin guardar quién leyó. Para no contar dos
veces a la misma persona el mismo día se usa un resumen temporal, que anota si
trajo prueba de trabajo y se descarta al terminar el día. Su llave cambia cada
día y solo se guarda ese día, fuera de la base de datos y de los respaldos.

**Sobre lo que se borra:** la base de datos conserva su propia copia hasta por
30 días en Cloudflare, para recuperarse de una falla. Lo que se borra de ella,
como los resúmenes de lectura y de red, un correo o una llave que pediste borrar
o el registro de un documento, sigue ahí hasta entonces. Los documentos no: se
borran de inmediato.

## De quién, de dónde y con qué base

Guarda datos de cinco grupos de personas: quienes comparten desde Tisty,
quienes editan lo que otra persona compartió, quienes abren un link, quienes
denuncian y quienes le escriben al operador. Todo
llega de ti, desde tu Tisty o tu navegador, o de tu conexión, que es de donde
Cloudflare saca el país y el centro de datos. Una denuncia trae lo que quien
denuncia escribió sobre un documento. Nada viene de fuentes de acceso público.

- **Compartir, editar y servir lo compartido** es lo que pides al aceptar los
  [términos](TERMINOS.md).
- **Los topes, los resúmenes de red, las denuncias, los registros y los
  respaldos** responden al interés legítimo de que el servicio siga seguro,
  dentro de su costo y sin abusos. Ese interés nunca necesita saber quién eres.
- **Lo que pide una autoridad** se guarda o se entrega por obligación legal.
- **El correo que dejas en una denuncia** es lo único que depende de tu
  consentimiento. Puedes retirarlo cuando quieras pidiendo que se borre, y eso
  no cambia lo que ya se hizo con él.

## Cloudflare y otros proveedores

Folio corre en Cloudflare (Workers, D1 y R2). Cloudflare recibe tu IP y
las peticiones al conectarte, como cualquier servidor web, y las trata según su
propia [política de privacidad](https://www.cloudflare.com/privacypolicy/).
Nunca recibe la llave del `#`, así que tampoco puede leer lo que compartes.

La portada de tisty.cl, y la página que muestra cuando un link ya no está, solo
explican qué es Folio. Son archivos fijos: no guardan nada de ti, ni en el
servidor ni en tu navegador. Cloudflare también recibe tu IP y tus peticiones al
visitarlas. En la página que lee un link, si eliges el modo claro u oscuro, o el
idioma de un documento, tu navegador recuerda esa elección, el idioma junto al
identificador de ese link. No sale de tu equipo, y queda hasta que borres los
datos del sitio en tu navegador.

También participan otros tres, cada uno con su propia política:

- **[Migadu](https://www.migadu.com/privacy/)** lleva y guarda el correo del
  operador, con lo que dice la tabla de arriba.
- **[GitHub](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement)**
  guarda las copias de la base de datos, cifradas con una llave que no tiene.
  Tisty también le pide los límites, los términos y el dominio de sus links, así
  que GitHub recibe la IP de quien va a compartir.
- **[Healthchecks.io](https://healthchecks.io/privacy/)** recibe una señal cuando
  termina cada tarea programada, para avisar si deja de llegar. No lleva datos
  de nadie.

Estos proveedores operan fuera de Chile, así que lo que reciben sale del país:
Cloudflare y GitHub desde Estados Unidos, Migadu desde Suiza y Healthchecks.io
desde Letonia, en la Unión Europea. La Agencia de Protección de Datos Personales
todavía no declara qué países ofrecen un nivel adecuado de protección. Mientras
tanto, las garantías son la política de cada proveedor, enlazada arriba, y que
lo compartido les llega cifrado.

Cuando el operador avisa de phishing o malware, Google Safe Browsing (Estados
Unidos) y Cloudflare reciben la dirección del sitio que engaña, nunca la llave de
un documento. Lo que parece un delito va a la PDI o a la Fiscalía.

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

## Lo que se decide solo

Algunas reglas actúan sin que nadie mire, siempre sobre una llave, una red o un
documento, nunca sobre una persona que se conozca:

- **Una llave nueva** parte con los topes más bajos durante sus primeros 30
  días, y cada red trae solo unas pocas llaves nuevas al día.
- **Una red que pasa su cupo** espera, y pasado cierto número de lectores el
  navegador hace un pequeño trabajo de cómputo antes de leer.
- **Las denuncias** pueden pedirle a quien compartió una versión nueva, o
  bloquear un documento, cuando llegan desde varias redes de proveedores
  distintos.

Los [términos](TERMINOS.md) dicen cada umbral y cómo se reclama. El operador
puede revisar y deshacer lo que estas reglas hicieron.

## La seguridad

Lo que protege el diseño y cómo reportar una falla está en la
[política de seguridad](SEGURIDAD.md). Si una falla expone datos personales, el
operador la informa a la Agencia de Protección de Datos Personales y, cuando la
ley lo pide, a cada persona afectada.

## Tus derechos

Bajo la Ley 21.719 puedes pedir saber qué datos tuyos hay, corregirlos,
borrarlos, oponerte a su uso, llevártelos o bloquearlos mientras se resuelve
otra petición. El operador responde dentro de 30 días corridos. Lo que
compartiste ya está en tu Tisty, en su formato, y Folio no guarda otra copia
que pueda leer. Como no hay cuentas, lo más directo es:

- **Borrar lo que compartiste:** con tu link de administración, o dejando de
  compartirlo desde Tisty. Deja de servirse de inmediato y se borra del servidor
  en la siguiente limpieza, normalmente antes de una hora; durante un bloqueo por
  gasto o una falla puede tardar más. Una denuncia seria o una orden pueden
  obligar a conservarlo.
- **El correo que dejaste en una denuncia:** escribe a <abuso@tisty.app> con el
  id del documento y el operador lo borra. Sigue hasta 30 días en los respaldos
  cifrados.
- **Cualquier otra petición:** escribe a <rgdevment@tisty.app>. El resumen de
  tu IP no dice quién eres, pero con tu IP el operador puede encontrar lo que se
  guarda bajo ella mientras dure su llave: un día para los cupos y las lecturas,
  y hasta 180 días para las denuncias.
- **Tu llave pública:** solo tú puedes demostrar que es tuya, así que firma la
  petición con ella. Sale de la lista de llaves y parte de nuevo como una
  nueva, sin su reputación y sin ninguna marca. Sigue mientras duren estos
  lugares: en los documentos que sigues compartiendo y las versiones que firmaste,
  en una llave que retiraste, en lo que guarda una denuncia hasta por 180 días,
  en el registro del operador hasta por 180 días y en los respaldos por 30 días.
  Una llave que el operador bloqueó sigue bloqueada.

Si el operador no responde a tiempo o rechaza tu petición, puedes reclamar ante
la Agencia de Protección de Datos Personales.

## Menores de edad

Folio no está pensado para menores de 14 años.

## Cambios

Cada cambio a esta política queda en el repositorio público, con su fecha. Si
las dos versiones difieren, rige la versión en español.

[English](PRIVACY.md)
