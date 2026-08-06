#ifndef CLOVY_COMPANION_CRYPTO_H
#define CLOVY_COMPANION_CRYPTO_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define CLOVY_CRYPTO_KEY_BYTES 32

typedef struct ClovyCryptoSession ClovyCryptoSession;

int32_t clovy_crypto_generate_identity(uint8_t *private_out, uint8_t *public_out);
ClovyCryptoSession *clovy_crypto_pairing_session_new(bool initiator,
                                                     const uint8_t *local_private,
                                                     const uint8_t *pairing_secret);
ClovyCryptoSession *clovy_crypto_linked_session_new(bool initiator,
                                                    const uint8_t *local_private,
                                                    const uint8_t *remote_public);
int32_t clovy_crypto_session_write(ClovyCryptoSession *session, const uint8_t *input,
                                   size_t input_len, uint8_t *output,
                                   size_t output_capacity, size_t *output_len);
int32_t clovy_crypto_session_read(ClovyCryptoSession *session, const uint8_t *input,
                                  size_t input_len, uint8_t *output,
                                  size_t output_capacity, size_t *output_len);
bool clovy_crypto_session_is_ready(const ClovyCryptoSession *session);
int32_t clovy_crypto_session_remote_static(const ClovyCryptoSession *session,
                                           uint8_t *output);
void clovy_crypto_session_free(ClovyCryptoSession *session);

#endif
