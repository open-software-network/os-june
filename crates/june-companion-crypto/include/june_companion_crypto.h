#ifndef JUNE_COMPANION_CRYPTO_H
#define JUNE_COMPANION_CRYPTO_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define JUNE_CRYPTO_KEY_BYTES 32

typedef struct JuneCryptoSession JuneCryptoSession;

int32_t june_crypto_generate_identity(uint8_t *private_out, uint8_t *public_out);
JuneCryptoSession *june_crypto_pairing_session_new(bool initiator,
                                                   const uint8_t *local_private,
                                                   const uint8_t *pairing_secret);
JuneCryptoSession *june_crypto_linked_session_new(bool initiator,
                                                  const uint8_t *local_private,
                                                  const uint8_t *remote_public);
int32_t june_crypto_session_write(JuneCryptoSession *session, const uint8_t *input,
                                  size_t input_len, uint8_t *output,
                                  size_t output_capacity, size_t *output_len);
int32_t june_crypto_session_read(JuneCryptoSession *session, const uint8_t *input,
                                 size_t input_len, uint8_t *output,
                                 size_t output_capacity, size_t *output_len);
bool june_crypto_session_is_ready(const JuneCryptoSession *session);
int32_t june_crypto_session_remote_static(const JuneCryptoSession *session,
                                          uint8_t *output);
void june_crypto_session_free(JuneCryptoSession *session);

#endif
