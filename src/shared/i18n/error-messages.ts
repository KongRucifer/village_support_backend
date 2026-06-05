export interface ErrorTranslations {
  en: string;
  lo: string;
}

export const ERROR_MESSAGES: Record<string, ErrorTranslations> = {
  // Auth errors
  'Username is required': {
    en: 'Username is required',
    lo: 'ຕ້ອງການຊື່ຜູ້ໃຊ້',
  },
  'Password is required': {
    en: 'Password is required',
    lo: 'ຕ້ອງການລະຫັດຜ່ານ',
  },
  'Username is incorrect': {
    en: 'Username is incorrect',
    lo: 'ຊື່ຜູ້ໃຊ້ບໍ່ຖືກຕ້ອງ',
  },
  'Password is incorrect': {
    en: 'Password is incorrect',
    lo: 'ລະຫັດຜ່ານບໍ່ຖືກຕ້ອງ',
  },
  'Password and confirm password do not match': {
    en: 'Password and confirm password do not match',
    lo: 'ລະຫັດຜ່ານ ແລະ ຢືນຢັນລະຫັດຜ່ານບໍ່ກົງກັນ',
  },
  'Invalid village code or bankbook number': {
    en: 'Invalid village code or bankbook number',
    lo: 'ລະຫັດບ້ານ ຫຼື ເລກບັນຊີບັນຊີບໍ່ຖືກຕ້ອງ',
  },
  'Username already exists': {
    en: 'Username already exists',
    lo: 'ຊື່ຜູ້ໃຊ້ມີແລ້ວ',
  },
  'Username must be at least 3 characters': {
    en: 'Username must be at least 3 characters',
    lo: 'ຊື່ຜູ້ໃຊ້ຕ້ອງມີຢ່າງນ້ອຍ 3 ຕົວອັກສອນ',
  },
  'Phone number is required': {
    en: 'Phone number is required',
    lo: 'ຕ້ອງການເບີໂທລະສັບ',
  },
  'Phone number not found or account not found': {
    en: 'Phone number not found or account not found',
    lo: 'ບໍ່ພົບເບີໂທລະສັບ ຫຼື ບໍ່ພົບບັນຊີ',
  },
  'No account found for this phone number': {
    en: 'No account found for this phone number',
    lo: 'ບໍ່ພົບບັນຊີສຳລັບເບີໂທລະສັບນີ້',
  },
  'Cannot connect to server. Please check your connection.': {
    en: 'Cannot connect to server. Please check your connection.',
    lo: 'ບໍ່ສາມາດເຊື່ອມຕໍ່ server ໄດ້. ກວດສອບການເຊື່ອມຕໍ່ຂອງທ່ານ.',
  },
  'Login failed': {
    en: 'Login failed',
    lo: 'ການເຂົ້າສູ່ລະບົບລົ້ມເຫຼວ',
  },
  'Registration failed': {
    en: 'Registration failed',
    lo: 'ການລົງທະບຽນລົ້ມເຫຼວ',
  },
  'Reset password failed': {
    en: 'Reset password failed',
    lo: 'ການຕັ້ງລະຫັດຜ່ານໃຫມ່ລົ້ມເຫຼວ',
  },
  'Server error': {
    en: 'Server error',
    lo: 'ຜິດພາດເຊີບເວີ',
  },
};

export function getTranslatedError(message: string, language: 'en' | 'lo' = 'en'): string {
  const errorTranslation = ERROR_MESSAGES[message];
  if (errorTranslation) {
    return errorTranslation[language];
  }
  
  // Try to find partial matches
  for (const [key, translation] of Object.entries(ERROR_MESSAGES)) {
    if (message.toLowerCase().includes(key.toLowerCase()) || key.toLowerCase().includes(message.toLowerCase())) {
      return translation[language];
    }
  }
  
  // Return original message if no translation found
  return message;
}
