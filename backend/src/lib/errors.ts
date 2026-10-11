import type { Lang } from './i18n.js';

export const ERROR_STATUS = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  TICKET_INVALID: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  USERNAME_TAKEN: 409,
  REVISION_CONFLICT: 409,
  UNDO_CONFLICT: 409,
  NOTHING_TO_UNDO: 409,
  NOTHING_TO_REDO: 409,
  IDEMPOTENCY_MISMATCH: 409,
  LINK_DISABLED: 410,
  INVITATION_INVALID: 410,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  INVALID_SCENE: 422,
  INVALID_REFERENCE: 422,
  UNSUPPORTED_OPERATION: 422,
  LIMIT_EXCEEDED: 422,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  AI_UNAVAILABLE: 503,
  AI_INVALID_PLAN: 422,
  AI_CANCELLED: 409,
  DONATION_UNVERIFIED: 422,
  INSUFFICIENT_FUNDS: 422,
  SERVICE_UNAVAILABLE: 503,
  AI_TIMEOUT: 504,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

// User-facing messages. ht/fr/es/ko were written by the implementer and should be
// reviewed by native speakers before a public release.
const MESSAGES: Record<ErrorCode, Record<Lang, string>> = {
  VALIDATION_FAILED: {
    en: 'The request is not valid.',
    ht: 'Demann lan pa valab.',
    fr: "La requête n'est pas valide.",
    es: 'La solicitud no es válida.',
    ko: '요청이 올바르지 않습니다.',
  },
  UNAUTHENTICATED: {
    en: 'Please sign in to continue.',
    ht: 'Tanpri konekte pou kontinye.',
    fr: 'Veuillez vous connecter pour continuer.',
    es: 'Inicia sesión para continuar.',
    ko: '계속하려면 로그인하세요.',
  },
  INVALID_CREDENTIALS: {
    en: 'Username or password is incorrect.',
    ht: 'Non itilizatè a oswa modpas la pa kòrèk.',
    fr: "Nom d'utilisateur ou mot de passe incorrect.",
    es: 'El nombre de usuario o la contraseña son incorrectos.',
    ko: '사용자 이름 또는 비밀번호가 올바르지 않습니다.',
  },
  TICKET_INVALID: {
    en: 'This connection ticket is invalid or has expired.',
    ht: 'Tikè koneksyon sa a pa valab oswa li ekspire.',
    fr: 'Ce ticket de connexion est invalide ou a expiré.',
    es: 'Este ticket de conexión no es válido o ha caducado.',
    ko: '연결 티켓이 유효하지 않거나 만료되었습니다.',
  },
  FORBIDDEN: {
    en: "You don't have permission to do that.",
    ht: 'Ou pa gen pèmisyon pou fè sa.',
    fr: "Vous n'avez pas l'autorisation de faire cela.",
    es: 'No tienes permiso para hacer eso.',
    ko: '이 작업을 수행할 권한이 없습니다.',
  },
  NOT_FOUND: {
    en: 'Not found.',
    ht: 'Nou pa jwenn li.',
    fr: 'Introuvable.',
    es: 'No encontrado.',
    ko: '찾을 수 없습니다.',
  },
  USERNAME_TAKEN: {
    en: 'This username is already taken.',
    ht: 'Yon lòt moun deja pran non itilizatè sa a.',
    fr: "Ce nom d'utilisateur est déjà pris.",
    es: 'Este nombre de usuario ya está en uso.',
    ko: '이미 사용 중인 사용자 이름입니다.',
  },
  REVISION_CONFLICT: {
    en: 'Someone else changed the gallery. Refresh and try again.',
    ht: 'Yon lòt moun chanje galri a. Rafrechi epi eseye ankò.',
    fr: "Quelqu'un d'autre a modifié la galerie. Actualisez et réessayez.",
    es: 'Otra persona cambió la galería. Actualiza e inténtalo de nuevo.',
    ko: '다른 사람이 갤러리를 변경했습니다. 새로고침 후 다시 시도하세요.',
  },
  UNDO_CONFLICT: {
    en: "This can't be undone safely because someone else changed the same items.",
    ht: 'Nou pa ka anile sa a san danje paske yon lòt moun chanje menm bagay yo.',
    fr: "Impossible d'annuler sans risque : quelqu'un d'autre a modifié les mêmes éléments.",
    es: 'No se puede deshacer con seguridad porque otra persona cambió los mismos elementos.',
    ko: '다른 사람이 같은 항목을 변경해서 안전하게 실행 취소할 수 없습니다.',
  },
  NOTHING_TO_UNDO: {
    en: 'There is nothing to undo.',
    ht: 'Pa gen anyen pou anile.',
    fr: "Il n'y a rien à annuler.",
    es: 'No hay nada que deshacer.',
    ko: '실행 취소할 항목이 없습니다.',
  },
  NOTHING_TO_REDO: {
    en: 'There is nothing to redo.',
    ht: 'Pa gen anyen pou refè.',
    fr: "Il n'y a rien à rétablir.",
    es: 'No hay nada que rehacer.',
    ko: '다시 실행할 항목이 없습니다.',
  },
  IDEMPOTENCY_MISMATCH: {
    en: 'This request ID was already used for a different request.',
    ht: 'Yo te deja itilize ID demann sa a pou yon lòt demann.',
    fr: 'Cet identifiant de requête a déjà servi pour une autre requête.',
    es: 'Este ID de solicitud ya se usó para otra solicitud.',
    ko: '이 요청 ID는 이미 다른 요청에 사용되었습니다.',
  },
  LINK_DISABLED: {
    en: 'This link is no longer active.',
    ht: 'Lyen sa a pa aktif ankò.',
    fr: "Ce lien n'est plus actif.",
    es: 'Este enlace ya no está activo.',
    ko: '이 링크는 더 이상 사용할 수 없습니다.',
  },
  INVITATION_INVALID: {
    en: 'This invitation is invalid, expired, or already used.',
    ht: 'Envitasyon sa a pa valab, li ekspire, oswa yo deja itilize l.',
    fr: 'Cette invitation est invalide, expirée ou déjà utilisée.',
    es: 'Esta invitación no es válida, caducó o ya se usó.',
    ko: '이 초대는 유효하지 않거나 만료되었거나 이미 사용되었습니다.',
  },
  PAYLOAD_TOO_LARGE: {
    en: 'The file or request is too large.',
    ht: 'Fichye a oswa demann lan twò gwo.',
    fr: 'Le fichier ou la requête est trop volumineux.',
    es: 'El archivo o la solicitud es demasiado grande.',
    ko: '파일 또는 요청이 너무 큽니다.',
  },
  UNSUPPORTED_MEDIA_TYPE: {
    en: 'This file type is not supported.',
    ht: 'Kalite fichye sa a pa sipòte.',
    fr: "Ce type de fichier n'est pas pris en charge.",
    es: 'Este tipo de archivo no es compatible.',
    ko: '지원하지 않는 파일 형식입니다.',
  },
  INVALID_SCENE: {
    en: 'This change would make the gallery invalid.',
    ht: 'Chanjman sa a ta fè galri a pa valab.',
    fr: 'Cette modification rendrait la galerie invalide.',
    es: 'Este cambio dejaría la galería en un estado no válido.',
    ko: '이 변경으로 갤러리가 올바르지 않게 됩니다.',
  },
  INVALID_REFERENCE: {
    en: 'The change refers to an item or image that does not exist.',
    ht: 'Chanjman an pale de yon eleman oswa yon imaj ki pa egziste.',
    fr: "La modification fait référence à un élément ou une image qui n'existe pas.",
    es: 'El cambio hace referencia a un elemento o imagen que no existe.',
    ko: '존재하지 않는 항목이나 이미지를 참조하고 있습니다.',
  },
  UNSUPPORTED_OPERATION: {
    en: 'This change is not supported.',
    ht: 'Chanjman sa a pa sipòte.',
    fr: "Cette modification n'est pas prise en charge.",
    es: 'Este cambio no es compatible.',
    ko: '지원하지 않는 변경입니다.',
  },
  LIMIT_EXCEEDED: {
    en: 'A size or count limit was exceeded.',
    ht: 'Ou depase yon limit gwosè oswa kantite.',
    fr: 'Une limite de taille ou de nombre a été dépassée.',
    es: 'Se superó un límite de tamaño o cantidad.',
    ko: '크기 또는 개수 제한을 초과했습니다.',
  },
  RATE_LIMITED: {
    en: 'Too many requests. Please wait a moment.',
    ht: 'Twòp demann. Tanpri tann yon ti moman.',
    fr: 'Trop de requêtes. Veuillez patienter un instant.',
    es: 'Demasiadas solicitudes. Espera un momento.',
    ko: '요청이 너무 많습니다. 잠시 후 다시 시도하세요.',
  },
  INTERNAL: {
    en: 'Something went wrong on the server.',
    ht: 'Gen yon pwoblèm ki rive sou sèvè a.',
    fr: 'Une erreur est survenue sur le serveur.',
    es: 'Ocurrió un error en el servidor.',
    ko: '서버에서 문제가 발생했습니다.',
  },
  AI_UNAVAILABLE: {
    en: 'The assistant is unavailable right now.',
    ht: 'Asistan an pa disponib kounye a.',
    fr: "L'assistant est indisponible pour le moment.",
    es: 'El asistente no está disponible en este momento.',
    ko: '지금은 어시스턴트를 사용할 수 없습니다.',
  },
  SERVICE_UNAVAILABLE: {
    en: 'The service is temporarily unavailable.',
    ht: 'Sèvis la pa disponib pou kounye a.',
    fr: 'Le service est temporairement indisponible.',
    es: 'El servicio no está disponible temporalmente.',
    ko: '서비스를 일시적으로 사용할 수 없습니다.',
  },
  AI_INVALID_PLAN: {
    en: "The assistant couldn't turn that into a valid change. Nothing was changed.",
    ht: 'Asistan an pa t ka fè sa tounen yon chanjman ki valab. Anyen pa t chanje.',
    fr: "L'assistant n'a pas pu en faire une modification valide. Rien n'a été modifié.",
    es: 'El asistente no pudo convertir eso en un cambio válido. No se cambió nada.',
    ko: '어시스턴트가 이를 올바른 변경으로 만들지 못했습니다. 아무것도 변경되지 않았습니다.',
  },
  DONATION_UNVERIFIED: {
    en: "We couldn't verify this donation on the blockchain yet.",
    ht: 'Nou poko ka verifye don sa a sou blockchain la.',
    fr: "Nous n'avons pas encore pu vérifier ce don sur la blockchain.",
    es: 'Todavía no pudimos verificar esta donación en la blockchain.',
    ko: '아직 블록체인에서 이 기부를 확인하지 못했습니다.',
  },
  INSUFFICIENT_FUNDS: {
    en: 'The donation wallet does not have enough funds for this withdrawal.',
    ht: 'Bous don an pa gen ase lajan pou retrè sa a.',
    fr: "Le portefeuille de dons n'a pas assez de fonds pour ce retrait.",
    es: 'La billetera de donaciones no tiene fondos suficientes para este retiro.',
    ko: '기부 지갑에 이 출금을 위한 잔액이 부족합니다.',
  },
  AI_CANCELLED: {
    en: 'The request was cancelled. Nothing was changed.',
    ht: 'Demann lan te anile. Anyen pa t chanje.',
    fr: "La demande a été annulée. Rien n'a été modifié.",
    es: 'La solicitud se canceló. No se cambió nada.',
    ko: '요청이 취소되었습니다. 아무것도 변경되지 않았습니다.',
  },
  AI_TIMEOUT: {
    en: 'The assistant took too long to respond.',
    ht: 'Asistan an pran twòp tan pou reponn.',
    fr: "L'assistant a mis trop de temps à répondre.",
    es: 'El asistente tardó demasiado en responder.',
    ko: '어시스턴트의 응답 시간이 초과되었습니다.',
  },
};

export function localizedMessage(code: ErrorCode, lang: Lang): string {
  return MESSAGES[code][lang] ?? MESSAGES[code].en;
}

export class AppError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    readonly details?: Record<string, unknown>,
    detailMessage?: string,
  ) {
    super(detailMessage ?? code);
    this.status = ERROR_STATUS[code];
  }
}

export const errors = {
  validation: (details?: Record<string, unknown>, msg?: string) => new AppError('VALIDATION_FAILED', details, msg),
  forbidden: (msg?: string) => new AppError('FORBIDDEN', undefined, msg),
  notFound: (what?: string) => new AppError('NOT_FOUND', what ? { what } : undefined),
  unauthenticated: () => new AppError('UNAUTHENTICATED'),
};
